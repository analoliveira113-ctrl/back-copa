import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();

// Configurações Globais
app.use(cors());
app.use(express.json());

// 1. Conexão com o Supabase utilizando a Service Role (Admin)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("ERRO: Verifique se as variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_KEY) estão no seu .env");
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

// Listar todos os posts do Feed principal -> Tela Feed
app.get('/api/posts', async (req, res) => {
    try {
        // Busca os posts trazendo junto o username e avatar do criador, além de contar os likes de cada post
        const { data, error } = await supabase
            .from('posts')
            .select(`
                *,
                profiles:user_id (username, avatar_url, favorite_team),
                likes (user_id)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
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
    try {
        // Verifica se o usuário já curtiu esse post
        const { data: existingLike, error: searchError } = await supabase
            .from('likes')
            .where('post_id', 'eq', post_id)
            .where('user_id', 'eq', user_id)
            .maybeSingle();

        if (existingLike) {
            // Se já curtiu, nós removemos (Descurtir)
            await supabase.from('likes').delete().match({ post_id, user_id });
            return res.json({ status: 'unliked', message: 'Gol anulado pelo VAR!' });
        } else {
            // Se não curtiu, nós adicionamos (Curtir)
            await supabase.from('likes').insert([{ post_id, user_id }]);
            return res.json({ status: 'liked', message: 'GOOOOL!' });
        }
    } catch (err) {
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
// Altere o final do seu api/server.js para isso:
const PORT = process.env.PORT || 3000;

// Só inicia o listen se não estiver rodando na Vercel (localmente)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`⚽ API CopaGram executando localmente na porta ${PORT}`);
    });
}

// Essencial para a Vercel encontrar as rotas:
export default app;