const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const https = require('https');
const app = express();
const server = http.createServer(app);

const IDIOMAS = ['es', 'en', 'fr', 'pt', 'de'];

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket']
});

app.get('/contenido.json', (req, res) => {
    console.log(`📄 /contenido.json → nombre: "${contenido.evento.nombre}"`);
    res.json(contenido);
});

// Endpoint multilenguaje: devuelve preguntas del idioma pedido
app.get('/preguntas/:idioma', (req, res) => {
    const lang = req.params.idioma;
    if (!IDIOMAS.includes(lang)) return res.status(400).json({ error: 'Idioma no soportado' });
    const pqs = preguntasPorIdioma[lang] || preguntasPorIdioma['es'] || [];
    res.json(pqs);
});

app.use(express.static('public'));

let contenido = null;
let preguntasTodo = [];                    // español por defecto (compatibilidad)
let preguntasPorIdioma = { es: [] };       // { es: [...], en: [...], fr: [...], pt: [...], de: [...] }
let jugadores = {};

const CONTENIDO_PATH = path.join(__dirname, 'contenido.json');
const PREGUNTAS_PATH = path.join(__dirname, 'preguntas.json');

try {
    contenido = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
    const pqs = JSON.parse(fs.readFileSync(PREGUNTAS_PATH, 'utf8'));
    preguntasTodo = pqs;
    preguntasPorIdioma.es = pqs;
} catch (err) {
    console.error("⚠️ Error cargando archivos JSON locales:", err.message);
}

const mongoUri = process.env.MONGO_URI;
let dbCollection = null;
let dbPreguntas = null;
let dbConfig = null;

async function conectarBaseDeDatos() {
    if (!mongoUri) {
        console.log("⚠️ Sin MONGO_URI. Modo memoria efímera.");
        return;
    }
    try {
        const client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(contenido.config.mongo_db);
        dbCollection = db.collection(contenido.config.mongo_col);
        dbPreguntas  = db.collection("preguntas_trivia");
        dbConfig     = db.collection("config_trivia");
        console.log("🚀 CONECTADO A MONGO DB ATLAS");

        // 1. Config del evento
        const configNube = await dbConfig.findOne({ tipo: "contenido_actual" });
        if (configNube) {
            contenido = configNube.datos;
            console.log(`📋 Config cargada desde la Nube: ${contenido.evento.nombre}`);
        }

        // 2. Preguntas multilenguaje desde Mongo
        const preguntasNube = await dbPreguntas.find({}).toArray();
        if (preguntasNube.length > 0) {
            // Detectar si son multilenguaje (tienen campo 'traducciones') o mono (compatibilidad)
            if (preguntasNube[0].traducciones) {
                // Formato multilenguaje: { id, traducciones: { es: {pregunta,correcta,incorrectas}, en: {...}, ... } }
                IDIOMAS.forEach(lang => {
                    preguntasPorIdioma[lang] = preguntasNube.map(p => ({
                        id: p.id,
                        pregunta: p.traducciones[lang]?.pregunta || p.traducciones.es.pregunta,
                        correcta: p.traducciones[lang]?.correcta || p.traducciones.es.correcta,
                        incorrectas: p.traducciones[lang]?.incorrectas || p.traducciones.es.incorrectas
                    }));
                });
                preguntasTodo = preguntasPorIdioma['es'];
            } else {
                // Formato legacy: solo español
                preguntasTodo = preguntasNube.map(p => ({ id: p.id, pregunta: p.pregunta, correcta: p.correcta, incorrectas: p.incorrectas }));
                preguntasPorIdioma['es'] = preguntasTodo;
            }
            console.log(`📦 Preguntas cargadas: ${preguntasNube.length} | Idiomas: ${Object.keys(preguntasPorIdioma).join(', ')}`);
        }

        // 3. Jugadores
        const historialNube = await dbCollection.find({}).toArray();
        historialNube.forEach(j => {
            if (j.puntos === undefined) j.puntos = 0;
            if (j.puntosRondaActual === undefined) j.puntosRondaActual = 0;
            if (!j.respondidas) j.respondidas = [];
            jugadores[j.username] = j;
        });
        console.log(`👥 Usuarios recuperados: ${Object.keys(jugadores).length}`);
        activarKeepAlive();
    } catch (error) {
        console.error("❌ Error crítico MongoDB:", error.message);
    }
}
conectarBaseDeDatos();

async function guardarRankingEnNube(username) {
    if (dbCollection && jugadores[username]) {
        try {
            const d = { ...jugadores[username] };
            delete d._id;
            await dbCollection.updateOne({ username }, { $set: d }, { upsert: true });
        } catch (err) {
            console.log(`❌ Error sync @${username}:`, err.message);
        }
    }
}

app.get('/datos_curiosos.json', (req, res) => {
    const lang = req.query.lang || 'es';
    const pqs = preguntasPorIdioma[lang] || preguntasPorIdioma['es'] || preguntasTodo;
    res.json(pqs.map(p => ({ id: p.id, pregunta: p.pregunta, dato: p.correcta })));
});

app.get('/preguntas_actuales.json', (req, res) => res.json(preguntasTodo));
app.get('/ranking_persistente.json', (req, res) => {
    res.json(Object.values(jugadores).sort((a, b) => b.puntos - a.puntos));
});

app.use(express.json({ limit: '2mb' }));

// ── GENERAR CON IA (ahora genera en todos los idiomas) ──────────────────────
app.post('/admin/generar-ia', async (req, res) => {
    try {
        const { tema } = req.body;
        if (!tema) return res.status(400).json({ ok: false, error: 'Falta el tema.' });

        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
        if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY no configurada');

        // Generar en español primero
        const promptES = `Generá exactamente 20 preguntas de trivia en español sobre: "${tema}". Respondé ÚNICAMENTE con un array JSON válido, sin texto antes ni después, sin markdown. Formato: [{"id":1,"pregunta":"...","correcta":"...","incorrectas":["...","...","..."]}]`;

        console.log(`🤖 Generando preguntas en español sobre: ${tema}`);
        const pgsEs = await llamarOpenRouter(promptES, OPENROUTER_API_KEY);

        // Generar traducciones
        const traducciones = {};
        const otrosIdiomas = [
            { code: 'en', nombre: 'English' },
            { code: 'fr', nombre: 'français' },
            { code: 'pt', nombre: 'português' },
            { code: 'de', nombre: 'Deutsch' }
        ];

        for (const lang of otrosIdiomas) {
            const promptTrad = `Translate the following trivia questions JSON to ${lang.nombre}. Keep the same JSON structure and array order. Return ONLY the JSON array, no markdown, no extra text:\n${JSON.stringify(pgsEs)}`;
            console.log(`🌐 Traduciendo a ${lang.nombre}...`);
            try {
                traducciones[lang.code] = await llamarOpenRouter(promptTrad, OPENROUTER_API_KEY);
            } catch (e) {
                console.log(`⚠️ Traducción ${lang.code} falló, usando español: ${e.message}`);
                traducciones[lang.code] = pgsEs;
            }
        }

        // Armar formato multilenguaje
        const preguntasMulti = pgsEs.map((p, i) => ({
            id: p.id || i + 1,
            traducciones: {
                es: { pregunta: p.pregunta, correcta: p.correcta, incorrectas: p.incorrectas },
                en: { pregunta: traducciones.en[i]?.pregunta || p.pregunta, correcta: traducciones.en[i]?.correcta || p.correcta, incorrectas: traducciones.en[i]?.incorrectas || p.incorrectas },
                fr: { pregunta: traducciones.fr[i]?.pregunta || p.pregunta, correcta: traducciones.fr[i]?.correcta || p.correcta, incorrectas: traducciones.fr[i]?.incorrectas || p.incorrectas },
                pt: { pregunta: traducciones.pt[i]?.pregunta || p.pregunta, correcta: traducciones.pt[i]?.correcta || p.correcta, incorrectas: traducciones.pt[i]?.incorrectas || p.incorrectas },
                de: { pregunta: traducciones.de[i]?.pregunta || p.pregunta, correcta: traducciones.de[i]?.correcta || p.correcta, incorrectas: traducciones.de[i]?.incorrectas || p.incorrectas }
            }
        }));

        return res.json({ ok: true, preguntas: preguntasMulti, preguntas_es: pgsEs });
    } catch (err) {
        console.error('❌ Error generación IA:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

async function llamarOpenRouter(prompt, apiKey) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'openrouter/free',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 8000
        })
    });
    if (!response.ok) throw new Error(`OpenRouter error ${response.status}`);
    const data = await response.json();
    let txt = data?.choices?.[0]?.message?.content || '';
    txt = txt.replace(/```json/gi, '').replace(/```/g, '').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").trim();
    const ini = txt.indexOf('['), fin = txt.lastIndexOf(']');
    if (ini === -1 || fin === -1) throw new Error('IA no devolvió array JSON válido');
    txt = txt.substring(ini, fin + 1);
    try { return JSON.parse(txt); }
    catch {
        const uc = txt.lastIndexOf('},');
        if (uc !== -1) return JSON.parse(txt.substring(0, uc + 1) + ']');
        throw new Error('JSON malformado');
    }
}

// ── TRADUCIR JSON SUBIDO MANUALMENTE ─────────────────────────────────────
app.post('/admin/traducir-preguntas', async (req, res) => {
    try {
        const { preguntas } = req.body;
        if (!preguntas || !Array.isArray(preguntas)) return res.status(400).json({ ok: false, error: 'Falta el array de preguntas.' });
        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
        if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY no configurada');

        const otrosIdiomas = [
            { code: 'en', nombre: 'English' },
            { code: 'fr', nombre: 'français' },
            { code: 'pt', nombre: 'português' },
            { code: 'de', nombre: 'Deutsch' }
        ];
        const traducciones = {};
        for (const lang of otrosIdiomas) {
            const prompt = `Translate the following trivia questions JSON to ${lang.nombre}. Keep same structure and order. Return ONLY the JSON array:\n${JSON.stringify(preguntas)}`;
            try { traducciones[lang.code] = await llamarOpenRouter(prompt, OPENROUTER_API_KEY); }
            catch { traducciones[lang.code] = preguntas; }
        }

        const preguntasMulti = preguntas.map((p, i) => ({
            id: p.id || i + 1,
            traducciones: {
                es: { pregunta: p.pregunta, correcta: p.correcta, incorrectas: p.incorrectas },
                en: { pregunta: traducciones.en[i]?.pregunta || p.pregunta, correcta: traducciones.en[i]?.correcta || p.correcta, incorrectas: traducciones.en[i]?.incorrectas || p.incorrectas },
                fr: { pregunta: traducciones.fr[i]?.pregunta || p.pregunta, correcta: traducciones.fr[i]?.correcta || p.correcta, incorrectas: traducciones.fr[i]?.incorrectas || p.incorrectas },
                pt: { pregunta: traducciones.pt[i]?.pregunta || p.pregunta, correcta: traducciones.pt[i]?.correcta || p.correcta, incorrectas: traducciones.pt[i]?.incorrectas || p.incorrectas },
                de: { pregunta: traducciones.de[i]?.pregunta || p.pregunta, correcta: traducciones.de[i]?.correcta || p.correcta, incorrectas: traducciones.de[i]?.incorrectas || p.incorrectas }
            }
        }));

        return res.json({ ok: true, preguntas: preguntasMulti });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── CAMBIAR TEMA (guarda preguntas multilenguaje) ────────────────────────
app.post('/admin/cambiar-tema', async (req, res) => {
    try {
        const { preguntas, evento_nombre, evento_subtitulo, emoji_1, emoji_2, emoji_3, url_publica, instagram_usuario } = req.body;
        if (!preguntas || !Array.isArray(preguntas) || preguntas.length < 10)
            return res.status(400).json({ ok: false, error: 'Se necesitan al menos 10 preguntas.' });
        if (!evento_nombre || !url_publica)
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });

        if (dbPreguntas && dbConfig) {
            await dbPreguntas.deleteMany({});
            await dbPreguntas.insertMany(preguntas);

            // Actualizar preguntasPorIdioma en memoria
            if (preguntas[0].traducciones) {
                IDIOMAS.forEach(lang => {
                    preguntasPorIdioma[lang] = preguntas.map(p => ({
                        id: p.id,
                        pregunta: p.traducciones[lang]?.pregunta || p.traducciones.es.pregunta,
                        correcta: p.traducciones[lang]?.correcta || p.traducciones.es.correcta,
                        incorrectas: p.traducciones[lang]?.incorrectas || p.traducciones.es.incorrectas
                    }));
                });
                preguntasTodo = preguntasPorIdioma['es'];
            } else {
                preguntasTodo = preguntas;
                preguntasPorIdioma['es'] = preguntas;
            }

            contenido.config.url_publica = url_publica;
            contenido.evento.nombre = evento_nombre;
            contenido.evento.subtitulo = evento_subtitulo || evento_nombre;
            contenido.login.titulo = '¡' + evento_nombre + '!';
            contenido.leaderboard.titulo_principal = evento_nombre;
            contenido.resultados.url_reinicio = url_publica;
            if (emoji_1 !== undefined) { contenido.evento.emoji_1 = emoji_1; contenido.evento.emoji_principal = emoji_1; }
            if (emoji_2 !== undefined) contenido.evento.emoji_2 = emoji_2;
            if (emoji_3 !== undefined) contenido.evento.emoji_3 = emoji_3;
            contenido.evento.emojis_header = [emoji_1, emoji_2, emoji_3].filter(Boolean).join(' ') || contenido.evento.emojis_header;
            if (instagram_usuario !== undefined) contenido.evento.instagram_usuario = instagram_usuario;

            await dbConfig.updateOne(
                { tipo: "contenido_actual" },
                { $set: { tipo: "contenido_actual", datos: contenido } },
                { upsert: true }
            );

            console.log(`🔄 TEMA ACTUALIZADO: "${evento_nombre}" | ${preguntas.length} preguntas`);
            res.json({ ok: true, mensaje: `Tema "${evento_nombre}" aplicado con ${preguntas.length} preguntas.`, preguntas_total: preguntas.length });
        } else {
            res.status(500).json({ ok: false, error: "MongoDB no inicializado." });
        }
    } catch (err) {
        console.error('❌ Error cambiar-tema:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── ACTUALIZAR SOLO CONFIG ───────────────────────────────────────────────
app.post('/admin/actualizar-config', async (req, res) => {
    try {
        const { evento_nombre, evento_subtitulo, emoji_1, emoji_2, emoji_3, url_publica, instagram_usuario } = req.body;
        if (!evento_nombre || !url_publica)
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });

        contenido.config.url_publica = url_publica;
        contenido.evento.nombre = evento_nombre;
        contenido.evento.subtitulo = evento_subtitulo || evento_nombre;
        contenido.login.titulo = '¡' + evento_nombre + '!';
        contenido.leaderboard.titulo_principal = evento_nombre;
        contenido.resultados.url_reinicio = url_publica;
        if (emoji_1 !== undefined) contenido.evento.emoji_1 = emoji_1;
        if (emoji_2 !== undefined) contenido.evento.emoji_2 = emoji_2;
        if (emoji_3 !== undefined) contenido.evento.emoji_3 = emoji_3;
        contenido.evento.emojis_header = [emoji_1, emoji_2, emoji_3].filter(Boolean).join(' ') || contenido.evento.emojis_header;
        if (emoji_1) contenido.evento.emoji_principal = emoji_1;
        if (instagram_usuario !== undefined) contenido.evento.instagram_usuario = instagram_usuario;

        if (dbConfig) {
            await dbConfig.updateOne({ tipo: 'contenido_actual' }, { $set: { tipo: 'contenido_actual', datos: contenido } }, { upsert: true });
        }
        console.log(`⚙️ CONFIG ACTUALIZADA: "${evento_nombre}"`);
        res.json({ ok: true, mensaje: `Config "${evento_nombre}" guardada.` });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── RESET CONFIG ────────────────────────────────────────────────────────
app.post('/admin/reset-config', async (req, res) => {
    try {
        contenido = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
        if (dbConfig) await dbConfig.deleteOne({ tipo: 'contenido_actual' });
        res.json({ ok: true, mensaje: 'Config reseteada al archivo local.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── RESET USUARIOS ──────────────────────────────────────────────────────
app.post('/admin/reset-usuarios', async (req, res) => {
    try {
        jugadores = {};
        if (dbCollection) await dbCollection.deleteMany({});
        enviarRankingAClientes();
        res.json({ ok: true, mensaje: 'Lista de usuarios limpiada.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── WEBSOCKETS ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('🔌 Nuevo cliente:', socket.id);
    socket.emit('update_ranking', Object.values(jugadores).sort((a, b) => b.puntos - a.puntos));

    socket.on('pedir_ranking_dashboard', () => {
        socket.emit('data_ranking_dashboard', Object.values(jugadores).sort((a, b) => b.puntos - a.puntos));
    });

    socket.on('join_game', ({ username, idioma }) => {
        const lang = IDIOMAS.includes(idioma) ? idioma : 'es';
        const cleanUsername = username.toLowerCase().replace('@', '').trim();
        if (jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0;
            jugadores[cleanUsername].socketId = socket.id;
        } else {
            jugadores[cleanUsername] = { username: cleanUsername, puntos: 0, puntosRondaActual: 0, vidas: 3, respondidas: [], combo: 0, socketId: socket.id };
        }
        socket.usernameClean = cleanUsername;
        socket.idioma = lang;
        guardarRankingEnNube(cleanUsername);
        enviarRankingAClientes();
    });

    socket.on('get_pregunta', () => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        if (jugador.vidas <= 0 || jugador.respondidas.length >= 10) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit(jugador.vidas <= 0 ? 'game_over' : 'game_completed', { puntos: jugador.puntosRondaActual, puesto });
            return;
        }

        const lang = socket.idioma || 'es';
        const pqs = preguntasPorIdioma[lang] || preguntasPorIdioma['es'] || preguntasTodo;
        const disponibles = pqs.filter(p => !jugador.respondidas.includes(p.id));
        if (disponibles.length === 0) {
            socket.emit('game_completed', { puntos: jugador.puntosRondaActual, puesto: obtenerPuesto(cleanUsername) });
            return;
        }

        const pregunta = disponibles[Math.floor(Math.random() * disponibles.length)];
        const opciones = [pregunta.correcta, ...pregunta.incorrectas].sort(() => Math.random() - 0.5);
        socket.emit('pregunta_data', { id: pregunta.id, pregunta: pregunta.pregunta, opciones, numeroPregunta: jugador.respondidas.length + 1 });
    });

    socket.on('enviar_respuesta', ({ preguntaId, respuesta, intento, tiempoEmpleado }) => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        if (respuesta === "__TIEMPO_AGOTADO__") {
            jugador.respondidas.push(preguntaId);
            jugador.vidas -= 1;
            jugador.combo = 0;
            socket.emit('resultado_respuesta', { correcta: false, tiempoAgotado: true, intento: 2, vidas: jugador.vidas });
            guardarRankingEnNube(cleanUsername);
            enviarRankingAClientes();
            return;
        }

        // Buscar la pregunta en CUALQUIER idioma para validar la respuesta
        const lang = socket.idioma || 'es';
        const pqs = preguntasPorIdioma[lang] || preguntasPorIdioma['es'] || preguntasTodo;
        const pregunta = pqs.find(p => p.id === preguntaId);
        if (!pregunta) return;

        const esCorrecta = pregunta.correcta === respuesta;
        if (esCorrecta) {
            jugador.respondidas.push(preguntaId);
            jugador.combo += 1;
            let puntosBase = intento === 1 ? 10 : 5;
            let bonusTiempo = Math.max(0, Math.round(15 * Math.log(20 / (tiempoEmpleado + 1))));
            let puntosPregunta = puntosBase + bonusTiempo;
            let multiplicador = jugador.combo === 3 ? 2 : jugador.combo === 6 ? 4 : jugador.combo === 9 ? 6 : 1;
            jugador.puntosRondaActual += puntosPregunta * multiplicador;
            if (jugador.puntosRondaActual > jugador.puntos) jugador.puntos = jugador.puntosRondaActual;
            socket.emit('resultado_respuesta', { correcta: true, puntos: jugador.puntosRondaActual, combo: jugador.combo });
        } else {
            if (intento === 1) {
                socket.emit('resultado_respuesta', { correcta: false, intento: 1 });
            } else {
                jugador.respondidas.push(preguntaId);
                jugador.vidas -= 1;
                jugador.combo = 0;
                socket.emit('resultado_respuesta', { correcta: false, intento: 2, vidas: jugador.vidas });
            }
        }
        guardarRankingEnNube(cleanUsername);
        enviarRankingAClientes();
    });

    socket.on('reset_game', () => {
        const cleanUsername = socket.usernameClean;
        if (cleanUsername && jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0;
            guardarRankingEnNube(cleanUsername);
            enviarRankingAClientes();
        }
    });

    socket.on('disconnect', () => console.log('🔌 Desconectado:', socket.id));
});

function obtenerPuesto(username) {
    const lista = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    const idx = lista.findIndex(j => j.username === username);
    return idx !== -1 ? idx + 1 : lista.length;
}

function enviarRankingAClientes() {
    const lista = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    io.emit('update_ranking', lista);
    io.emit('data_ranking_dashboard', lista);
}

function activarKeepAlive() {
    if (contenido?.config?.url_publica) {
        setInterval(() => {
            https.get(contenido.config.url_publica, () => {}).on('error', () => console.log('Ping KeepAlive fallido'));
        }, 300000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor v2.0 multilenguaje corriendo en puerto ${PORT}`));
