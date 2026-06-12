import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();

// Rota para a página inicial não dar "Cannot GET /"
app.get('/', (req, res) => {
    res.send('⚽ Back-end do CopaGram está online e operando! Pronto para o Hexa.');
});

// Configurações Globais de CORS e Parser
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Responder rapidamente a requisições de pré-voo (Pre-flight OPTIONS)
app.options('*', cors());
app.use(express.json());

// 1. Conexão com o Supabase utilizando a Service Role (Admin)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("ERRO: Verifique se as variáveis SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_KEY) estão no seu .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/* ===================================================================
   NOVA SEÇÃO: ROTAS DE AUTENTICAÇÃO (LOGIN E CADASTRO)
   =================================================================== */

// 1. Rota de Cadastro de Torcedores
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, username } = req.body;

    try {
        // Cadastra a conta pelas credenciais do Supabase Auth
        const { data, error } = await supabase.auth.signUp({ email, password });
        
        if (error) return res.status(400).json({ error: error.message });
        if (!data.user) return res.status(400).json({ error: "Erro ao registrar usuário." });

        // Vincula o username customizado salvando na tua tabela pública 'profiles'
        const { error: profileError } = await supabase
            .from('profiles')
            .insert([{ id: data.user.id, username: username }]);

        if (profileError) {
            return res.status(400).json({ error: `Conta criada, mas erro no perfil: ${profileError.message}` });
        }

        // Retorna o formato exato esperado pelo front-end
        return res.status(201).json({ 
            user: { id: data.user.id, username: username } 
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Erro interno no servidor de autenticação." });
    }
});

// 2. Rota de Login de Torcedores
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Valida as credenciais na base do Supabase Auth
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        
        if (error) return res.status(400).json({ error: error.message });

        // Busca o username que guardamos na tabela pública associado ao ID dele
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('username')
            .eq('id', data.user.id)
            .single();

        // Se por algum motivo o perfil não existir, usa um fallback amigável
        const usernameFinal = profile ? profile.username : "torcedor";

        return res.status(200).json({ 
            user: { id: data.user.id, username: usernameFinal } 
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Erro interno no servidor ao tentar logar." });
    }
});


/* ===================================================================
   CONFIGURAÇÃO DE ARMAZENAMENTO DE IMAGENS (MULTER & STORAGE)
   =================================================================== */

// Configuração do Multer (Guarda o arquivo temporariamente na memória do servidor)
const upload = multer({ storage: multer.memoryStorage() });

// Rota POST para criar uma nova publicação (recebe imagem + texto)
app.post('/api/posts', upload.single('image'), async (req, res) => {
    try {
        const { user_id, caption, match_tag } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'Nenhuma foto foi selecionada para envio.' });
        }

        // 1. Gera um nome único para o arquivo não sobrescrever outros no Bucket
        const formatoArquivo = file.originalname.split('.').pop();
        const nomeUnico = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${formatoArquivo}`;

        // 2. Faz o upload da foto diretamente para o Bucket criado no Supabase Storage
        const { data: storageData, error: storageError } = await supabase.storage
            .from('copagram-bucket') // Confirme se o nome do bucket no seu painel está exatamente igual
            .upload(nomeUnico, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (storageError) {
            return res.status(500).json({ error: `Erro no upload do Storage: ${storageError.message}` });
        }

        // 3. Pega a URL pública gerada para essa foto recém-enviada
        const { data: publicUrlData } = supabase.storage
            .from('copagram-bucket')
            .getPublicUrl(nomeUnico);

        const imageUrl = publicUrlData.publicUrl;

        // 4. Salva o registro completo da publicação na tabela 'posts' do banco de dados
        const { data: postInserido, error: dbError } = await supabase
            .from('posts')
            .insert([
                {
                    user_id,
                    image_url: imageUrl,
                    caption,
                    match_tag,
                    likes_count: 0
                }
            ])
            .select();

        if (dbError) {
            return res.status(500).json({ error: `Erro ao salvar post no banco: ${dbError.message}` });
        }

        return res.status(201).json(postInserido[0]);

    } catch (err) {
        return res.status(500).json({ error: `Erro inesperado no servidor: ${err.message}` });
    }
});

/* ===================================================================
   ROTAS DE INTERAÇÃO E FEED (POSTS, LIKES, PERFIL)
   =================================================================== */

// Buscar todas as publicações com informações de quem postou (Join)
app.get('/api/posts', async (req, res) => {
    try {
        const { data: posts, error } = await supabase
            .from('posts')
            .select(`
                id,
                image_url,
                caption,
                match_tag,
                likes_count,
                created_at,
                profiles (
                    id,
                    username,
                    avatar_url
                )
            `)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        return res.json(posts || []);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Sistema de Interações: Dar ou remover o golaço (Like / Unlike)
app.post('/api/posts/:id/like', async (req, res) => {
    const { id: post_id } = req.params;
    const { user_id } = req.body;

    try {
        // Verifica se aquele torcedor já curtiu este post antes
        const { data: curtidaExistente, error: erroBusca } = await supabase
            .from('likes')
            .select('*')
            .eq('post_id', post_id)
            .eq('user_id', user_id)
            .maybeSingle();

        if (erroBusca) return res.status(500).json({ error: erroBusca.message });

        if (curtidaExistente) {
            // Se já curtiu, removemos a curtida (Unlike)
            const { error: erroDelete } = await supabase
                .from('likes')
                .delete()
                .eq('id', curtidaExistente.id);

            if (erroDelete) return res.status(500).json({ error: erroDelete.message });

            // Decrementa o contador na tabela posts
            const { data: postAtualizado } = await supabase.rpc('decrement_likes', { row_id: post_id });
            
            // Fallback caso a RPC não esteja configurada: busca o valor atualizado
            const { data: post } = await supabase.from('posts').select('likes_count').eq('id', post_id).single();

            return res.json({ status: 'unliked', likesCount: post?.likes_count || 0 });
        } else {
            // Se não curtiu ainda, adiciona a linha na tabela de likes
            const { error: erroInsert } = await supabase
                .from('likes')
                .insert([{ post_id, user_id }]);

            if (erroInsert) return res.status(500).json({ error: erroInsert.message });

            // Incrementa o contador na tabela posts
            const { data: postAtualizado } = await supabase.rpc('increment_likes', { row_id: post_id });

            // Fallback caso a RPC não esteja configurada: busca o valor atualizado
            const { data: post } = await supabase.from('posts').select('likes_count').eq('id', post_id).single();

            return res.json({ status: 'liked', likesCount: post?.likes_count || 0 });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Buscar dados do perfil e as publicações específicas daquele torcedor
app.get('/api/profiles/:username', async (req, res) => {
    const { username } = req.params;
    try {
        // 1. Busca as infos do perfil
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('username', username)
            .single();

        if (profileError || !profile) return res.status(404).json({ error: 'Torcedor não encontrado.' });

        // 2. Busca as fotos que esse torcedor postou
        const { data: userPosts, error: postsError } = await supabase
            .from('posts')
            .select('id, image_url, caption, match_tag')
            .eq('user_id', profile.id)
            .order('created_at', { ascending: false });

        return res.json({
            profile,
            posts: userPosts || []
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Inicialização do Servidor na porta escolhida
const PORT = process.env.PORT || 3000;

// Só inicia o listen se não estiver rodando na Vercel (localmente)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`⚽ CopaGram rodando em campo na porta http://localhost:${PORT}`);
    });
}

export default app;
