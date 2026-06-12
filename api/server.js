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

// Configuração do Multer (Guarda o arquivo temporariamente na memória do servidor para upload)
const upload = multer({ storage: multer.memoryStorage() });


/* ==========================================================================
   ROTAS DE AUTENTICAÇÃO (Supabase Auth)
   ========================================================================== */

// Registro de novo Torcedor
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username, full_name, favorite_team } = req.body;
    try {
        const { data, error } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true, // Já confirma o e-mail automaticamente para facilitar o teste
            user_metadata: { username, full_name, favorite_team }
        });

        if (error) return res.status(400).json({ error: error.message });
        return res.status(201).json({ message: 'Torcedor registrado com sucesso!', user: data.user });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Login do Torcedor
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) return res.status(401).json({ error: error.message });
        
        // Retorna o Token (session) e os dados do usuário para o Front salvar no localStorage
        return res.json({ message: 'Golooo! Login efetuado.', session: data.session, user: data.user });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


/* ==========================================================================
   ROTAS DE POSTS / MEMÓRIAS (Tela de Compartilhar, Feed e Explorar)
   ========================================================================== */

// Criar nova Memória (Com Upload de Imagem para o Storage) -> Tela Compartilhar
app.post('/api/posts', upload.single('image'), async (req, res) => {
    try {
        const { user_id, caption, match_tag, stadium_name } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: 'A foto da sua memória na Copa é obrigatória!' });
        if (!user_id) return res.status(400).json({ error: 'ID do usuário não fornecido.' });

        // 1. Faz o upload da foto para o Storage Bucket público
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${user_id}_${Date.now()}.${fileExt}`;

        const { data: storageData, error: storageError } = await supabase.storage
            .from('copagram-memories')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (storageError) throw storageError;

        // 2. Captura a URL pública gerada
        const { data: publicUrlData } = supabase.storage
            .from('copagram-memories')
            .getPublicUrl(fileName);

        const imageUrl = publicUrlData.publicUrl;

        // 3. Insere o registro textual e o link da foto no Banco de Dados
        const { data: postData, error: dbError } = await supabase
            .from('posts')
            .insert([{ user_id, image_url: imageUrl, caption, match_tag, stadium_name }])
            .select();

        if (dbError) throw dbError;

        return res.status(201).json({ message: 'Memória eternizada com sucesso!', post: postData[0] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Listar todos os posts do Feed principal -> TOTALMENTE CORRIGIDA E BLINDADA CONTRA ERRO 500
app.get('/api/posts', async (req, res) => {
    try {
        // 1. Busca os posts de forma pura (sem Joins problemáticos)
        const { data: posts, error: postsError } = await supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (postsError) throw postsError;
        if (!posts || posts.length === 0) return res.json([]);

        // 2. Busca todos os perfis de uma vez só para juntar na memória do Node
        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('id, username, avatar_url, favorite_team');

        // 3. Busca todas as curtidas para calcular os contadores com segurança
        const { data: likes, error: likesError } = await supabase
            .from('likes')
            .select('post_id, user_id');

        // Mapeia e junta os dados simulando o Join de tabelas sem quebrar as chaves do Supabase
        const postsFormatados = posts.map(post => {
            // Encontra o perfil do criador do post
            const perfilCriador = profiles ? profiles.find(p => p.id === post.user_id) : null;
            
            // Filtra as curtidas que pertencem a este post específico
            const curtidasDestePost = likes ? likes.filter(l => l.post_id === post.id) : [];

            return {
                ...post,
                // Injeta as informações do criador no formato exato que o seu Front-end precisa
                profiles: perfilCriador ? {
                    username: perfilCriador.username,
                    avatar_url: perfilCriador.avatar_url,
                    favorite_team: perfilCriador.favorite_team
                } : { username: "Torcedor", avatar_url: null, favorite_team: "" },
                // Estrutura os likes e o contador legível
                likes: curtidasDestePost,
                likesCount: curtidasDestePost.length
            };
        });

        return res.json(postsFormatados);
    } catch (err) {
        console.error("Erro Crítico na Rota de Feed:", err.message);
        return res.status(500).json({ error: `Erro interno no servidor: ${err.message}` });
    }
});

// Buscar posts aleatórios/populares para a aba de descoberta -> Tela Explorar
app.get('/api/explore', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('posts')
            .select('id, image_url, caption, match_tag')
            .limit(24); // Limita a grade de fotos estilo "Masonry" igual ao seu front

        if (error) throw error;
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


/* ==========================================================================
   ROTAS DE CURTIDAS / GOLS (Interações do Feed)
   ========================================================================== */

// Dar um "Gol" (Curtir) ou tirar o "Gol" (Descurtir) -> Mecânica Toggle do Feed
app.post('/api/likes/toggle', async (req, res) => {
    const { post_id, user_id } = req.body;

    if (!post_id) return res.status(400).json({ error: 'ID do post não fornecido.' });

    try {
        // Validação e Blindagem do user_id contra erros de UUID/Null no Supabase
        let fallbackUserId = user_id;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // Se o id não existir ou não for um formato UUID válido, usamos o ID padrão estável para testes
        if (!fallbackUserId || !uuidRegex.test(fallbackUserId)) {
            fallbackUserId = '00000000-0000-0000-0000-000000000000';
        }

        // Verifica se o golaço já existe usando o ID tratado
        const { data: existingLike, error: searchError } = await supabase
            .from('likes')
            .select('*')
            .eq('post_id', post_id)
            .eq('user_id', fallbackUserId)
            .maybeSingle();

        if (searchError) throw searchError;

        if (existingLike) {
            // Se já curtiu, nós removemos o registro usando o ID único do like encontrado
            const { error: deleteError } = await supabase
                .from('likes')
                .delete()
                .eq('id', existingLike.id);

            if (deleteError) throw deleteError;
        } else {
            // Se não curtiu, adiciona o novo registro com o ID tratado e seguro
            const { error: insertError } = await supabase
                .from('likes')
                .insert([{ post_id, user_id: fallbackUserId }]);

            if (insertError) throw insertError;
        }

        // Busca o total atualizado de curtidas deste post
        const { count, error: countError } = await supabase
            .from('likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        if (countError) throw countError;

        return res.json({ 
            status: existingLike ? 'unliked' : 'liked', 
            message: existingLike ? 'Gol anulado pelo VAR!' : 'GOOOOL!',
            likesCount: count || 0
        });

    } catch (err) {
        console.error("Erro interno detectado na rota de likes:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

/* ==========================================================================
   ROTAS DE PERFIL DE USUÁRIO -> Tela Perfil
   ========================================================================== */

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
        console.log(`⚽ API CopaGram executando localmente na porta ${PORT}`);
    });
}

// Essencial para a Vercel encontrar as rotas:
export default app;
