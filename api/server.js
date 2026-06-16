import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();

// Rota para a página inicial
app.get('/', (req, res) => {
    res.send('⚽ Back-end do CopaGram está online e operando! Pronto para o Hexa.');
});

// ==========================================================================
// CONFIGURAÇÕES GLOBAIS
// ==========================================================================

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

// ==========================================================================
// CONEXÃO COM SUPABASE
// ==========================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("ERRO: Verifique as variáveis SUPABASE_URL e SUPABASE_ANON_KEY no seu .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================================================
// ROTA DE SAÚDE (para testar se a API está online)
// ==========================================================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'online', 
        timestamp: new Date().toISOString(),
        supabase: supabaseUrl ? 'conectado' : 'desconectado'
    });
});

// ==========================================================================
// ROTAS DE AUTENTICAÇÃO (CORRIGIDAS)
// ==========================================================================

// ✅ CADASTRO - VERSÃO QUE FUNCIONA SEM BEARER TOKEN
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, username, full_name, favorite_team } = req.body;
    try {
        // Usa o método padrão (NÃO admin) - NÃO precisa de Bearer token
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { 
                    username: username || email.split('@')[0],
                    full_name: full_name || username || email.split('@')[0],
                    favorite_team: favorite_team || 'Brasil'
                }
            }
        });

        if (error) return res.status(400).json({ error: error.message });
        
        // Retorna no formato que seu frontend espera
        return res.status(201).json({ 
            message: 'Torcedor registrado com sucesso!', 
            user: data.user 
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ✅ LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) return res.status(401).json({ error: error.message });
        
        return res.json({ 
            message: 'Golooo! Login efetuado.', 
            session: data.session, 
            user: data.user 
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
// ROTAS DE POSTS
// ==========================================================================

// ✅ CRIAR POST
app.post('/api/posts', upload.single('image'), async (req, res) => {
    try {
        const { user_id, caption, match_tag, stadium_name } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: 'A foto é obrigatória!' });
        if (!user_id) return res.status(400).json({ error: 'ID do usuário não fornecido.' });

        const fileExt = file.originalname.split('.').pop();
        const fileName = `${user_id}_${Date.now()}.${fileExt}`;

        const { data: storageData, error: storageError } = await supabase.storage
            .from('copagram-memories')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (storageError) throw storageError;

        const { data: publicUrlData } = supabase.storage
            .from('copagram-memories')
            .getPublicUrl(fileName);

        const imageUrl = publicUrlData.publicUrl;

        const { data: postData, error: dbError } = await supabase
            .from('posts')
            .insert([{ user_id, image_url: imageUrl, caption, match_tag, stadium_name }])
            .select();

        if (dbError) throw dbError;

        return res.status(201).json({ message: 'Memória eternizada!', post: postData[0] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ✅ LISTAR POSTS (FEED)
app.get('/api/posts', async (req, res) => {
    try {
        const { data: posts, error: postsError } = await supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (postsError) throw postsError;
        if (!posts || posts.length === 0) return res.json([]);

        const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('id, username, avatar_url, favorite_team');

        const { data: likes, error: likesError } = await supabase
            .from('likes')
            .select('post_id, user_id');

        const postsFormatados = posts.map(post => {
            const perfilCriador = profiles ? profiles.find(p => p.id === post.user_id) : null;
            const curtidasDestePost = likes ? likes.filter(l => l.post_id === post.id) : [];

            return {
                ...post,
                profiles: perfilCriador ? {
                    username: perfilCriador.username,
                    avatar_url: perfilCriador.avatar_url,
                    favorite_team: perfilCriador.favorite_team
                } : { username: "Torcedor", avatar_url: null, favorite_team: "" },
                likes: curtidasDestePost,
                likesCount: curtidasDestePost.length
            };
        });

        return res.json(postsFormatados);
    } catch (err) {
        console.error("Erro no Feed:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ✅ EXPLORAR (posts aleatórios)
app.get('/api/explore', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('posts')
            .select('id, image_url, caption, match_tag')
            .limit(24);

        if (error) throw error;
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
// ROTAS DE LIKES
// ==========================================================================

// ✅ ALTERNAR LIKE
app.post('/api/likes/toggle', async (req, res) => {
    const { post_id, user_id } = req.body;

    if (!post_id) return res.status(400).json({ error: 'ID do post não fornecido.' });

    try {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let fallbackUserId = user_id;

        if (!fallbackUserId || !uuidRegex.test(fallbackUserId)) {
            fallbackUserId = '00000000-0000-0000-0000-000000000000';
        }

        const { data: existingLike, error: searchError } = await supabase
            .from('likes')
            .select('*')
            .eq('post_id', post_id)
            .eq('user_id', fallbackUserId)
            .maybeSingle();

        if (searchError) throw searchError;

        if (existingLike) {
            const { error: deleteError } = await supabase
                .from('likes')
                .delete()
                .eq('id', existingLike.id);

            if (deleteError) throw deleteError;
        } else {
            const { error: insertError } = await supabase
                .from('likes')
                .insert([{ post_id, user_id: fallbackUserId }]);

            if (insertError) throw insertError;
        }

        const { count, error: countError } = await supabase
            .from('likes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', post_id);

        if (countError) throw countError;

        return res.json({ 
            status: existingLike ? 'unliked' : 'liked', 
            likesCount: count || 0
        });

    } catch (err) {
        console.error("Erro no like:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
// ROTA DE PERFIL
// ==========================================================================

app.get('/api/profiles/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('username', username)
            .single();

        if (profileError || !profile) return res.status(404).json({ error: 'Torcedor não encontrado.' });

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

// ==========================================================================
// EXPORTAÇÃO PARA VERCEL
// ==========================================================================

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`⚽ API CopaGram rodando na porta ${PORT}`);
    });
}

export default app;
