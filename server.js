const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb'); 
const https = require('https');
const app = express();
const server = http.createServer(app);

// ── CONFIGURACIÓN DE SOCKET.IO PARA PRODUCCIÓN (RENDER) ────────────────
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket'] 
});

app.get('/contenido.json', (req, res) => {
    console.log(`📄 /contenido.json → nombre: "${contenido.evento.nombre}" | emoji_1: "${contenido.evento.emoji_1}"`);
    res.json(contenido);
});

app.use(express.static('public'));

// Variables globales de configuración y estado en memorias
let contenido = null;
let preguntasTodo = [];
let jugadores = {}; 

const CONTENIDO_PATH = path.join(__dirname, 'contenido.json');
const PREGUNTAS_PATH = path.join(__dirname, 'preguntas.json');

// Cargar respaldos locales iniciales por seguridad
try {
    contenido = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
    preguntasTodo = JSON.parse(fs.readFileSync(PREGUNTAS_PATH, 'utf8'));
} catch (err) {
    console.error("⚠️ Error cargando archivos JSON locales de respaldo:", err.message);
}

const mongoUri = process.env.MONGO_URI; 
let dbCollection = null;     // Colección de jugadores
let dbPreguntas = null;      // Nueva colección para preguntas
let dbConfig = null;         // Nueva colección para textos/config del evento

async function conectarBaseDeDatos() {
    if (!mongoUri) {
        console.log("⚠️ ALERTA: No se detectó MONGO_URI. Funcionando en memoria de forma efímera.");
        return;
    }
    try {
        const client = new MongoClient(mongoUri);
        await client.connect();
        
        // Base de datos principal tomada del archivo de configuración inicial
        const db = client.db(contenido.config.mongo_db);       
        
        dbCollection = db.collection(contenido.config.mongo_col); 
        dbPreguntas = db.collection("preguntas_trivia");
        dbConfig = db.collection("config_trivia");
        
        console.log("🚀 CONECTADO EXITOSAMENTE A MONGO DB ATLAS");

        // 1. Cargar Configuración Dinámica del Evento desde la Nube
        const configNube = await dbConfig.findOne({ tipo: "contenido_actual" });
        if (configNube) {
            contenido = configNube.datos;
            console.log(`📋 Configuración cargada desde la Nube: ${contenido.evento.nombre}`);
        } else {
            console.log(`📋 Usando configuración local por defecto: ${contenido.evento.nombre}`);
        }

        // 2. Cargar Preguntas Dinámicas desde la Nube
        const preguntasNube = await dbPreguntas.find({}).toArray();
        if (preguntasNube.length > 0) {
            preguntasTodo = preguntasNube.map(p => ({
                id: p.id,
                pregunta: p.pregunta,
                correcta: p.correcta,
                incorrectas: p.incorrectas
            }));
            console.log(`📦 Preguntas sincronizadas desde la Nube: ${preguntasTodo.length}`);
        } else {
            console.log(`📦 Usando preguntas locales por defecto: ${preguntasTodo.length}`);
        }

        // 3. Recuperar Historial de Jugadores
        const historialNube = await dbCollection.find({}).toArray();
        historialNube.forEach(jugador => {
            if (jugador.puntos === undefined) jugador.puntos = 0;
            if (jugador.puntosRondaActual === undefined) jugador.puntosRondaActual = 0;
            if (!jugador.respondidas) jugador.respondidas = [];
            
            jugadores[jugador.username] = jugador;
        });
        console.log(`👥 Usuarios recuperados desde la nube: ${Object.keys(jugadores).length}`);
        
        // Iniciar el sistema de Auto-Ping una vez obtenida la URL pública de forma segura
        activarKeepAlive();

    } catch (error) {
        console.error("❌ Error crítico al conectar a MongoDB Atlas:", error.message);
    }
}

conectarBaseDeDatos();

// Guarda o actualiza los datos de un jugador en la nube
async function guardarRankingEnNube(username) {
    if (dbCollection && jugadores[username]) {
        try {
            const datosJugador = { ...jugadores[username] };
            delete datosJugador._id; 
            
            await dbCollection.updateOne(
                { username: username },
                { $set: datosJugador },
                { upsert: true }
            );
        } catch (err) {
            console.log(`❌ Error al sincronizar usuario @${username} con Atlas:`, err.message);
        }
    }
}

// Servir la configuración actualizada (prioriza memoria dinámica)
// [endpoint movido arriba]

// Servir datos curiosos generados dinámicamente desde las preguntas activas
app.get('/datos_curiosos.json', (req, res) => {
    const curiosos = preguntasTodo.map(p => ({
        id: p.id,
        pregunta: p.pregunta,
        dato: p.correcta
    }));
    res.json(curiosos);
});

app.get('/preguntas_actuales.json', (req, res) => {
    res.json(preguntasTodo);
});

app.get('/ranking_persistente.json', (req, res) => {
    let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    res.json(listaCompleta);
});

// ── CONFIGURACIÓN DE PARSERS Y MIDDLEWARES DE ADMIN ─────────────────────────
app.use(express.json({ limit: '500kb' }));

// ── ENDPOINT PUENTE SEGURO (LEE DESDE LA VARIABLE DE ENTORNO CONFIGURADA) ──
app.post('/admin/generar-ia', async (req, res) => {
    try {

        const { tema } = req.body;

        if (!tema) {
            return res.status(400).json({
                ok: false,
                error: 'Falta especificar el tema de la trivia.'
            });
        }

        const promptFinal = `Generá exactamente 20 preguntas de trivia en español sobre: "${tema}". Respondé ÚNICAMENTE con un array JSON válido, sin texto antes ni después, sin markdown, sin comentarios. Formato exacto: [{"id":1,"pregunta":"...","correcta":"...","incorrectas":["...","...","..."]},{"id":2,...}]`;

        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

        if (!OPENROUTER_API_KEY) {
            throw new Error('OPENROUTER_API_KEY no configurada');
        }

        console.log(`🤖 Llamando a OpenRouter (router automático de modelos gratuitos)...`);

        const response = await fetch(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openrouter/free',
                    messages: [
                        {
                            role: 'user',
                            content: promptFinal
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const modeloUsado = data?.model || 'desconocido';
        let contenidoIA = data?.choices?.[0]?.message?.content || null;

        if (!contenidoIA) {
            throw new Error('OpenRouter no devolvió contenido en la respuesta.');
        }

        console.log(`✅ Respuesta recibida via modelo: ${modeloUsado}`);

        // Limpiar markdown y texto basura
        contenidoIA = contenidoIA
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .replace(/[\u201C\u201D]/g, '"')  // comillas tipográficas
            .replace(/[\u2018\u2019]/g, "'")
            .trim();

        const inicio = contenidoIA.indexOf('[');
        const fin = contenidoIA.lastIndexOf(']');

        if (inicio === -1 || fin === -1) {
            throw new Error('La IA no devolvió un array JSON válido');
        }

        contenidoIA = contenidoIA.substring(inicio, fin + 1);

        // Intentar reparar JSON truncado: eliminar último objeto incompleto
        let preguntasValidadas;
        try {
            preguntasValidadas = JSON.parse(contenidoIA);
        } catch (parseErr) {
            // Cortar en la última coma antes del objeto incompleto y cerrar el array
            const ultimaComa = contenidoIA.lastIndexOf('},');
            if (ultimaComa !== -1) {
                contenidoIA = contenidoIA.substring(0, ultimaComa + 1) + ']';
                preguntasValidadas = JSON.parse(contenidoIA);
            } else {
                throw new Error('JSON malformado y no reparable: ' + parseErr.message);
            }
        }

        if (!Array.isArray(preguntasValidadas)) {
            throw new Error('La respuesta no es un array');
        }

        if (preguntasValidadas.length < 10) {
            throw new Error(
                `Solo se recibieron ${preguntasValidadas.length} preguntas`
            );
        }

        preguntasValidadas.forEach((p, i) => {
            if (!p.id) p.id = i + 1;
        });

        return res.json({
            ok: true,
            preguntas: preguntasValidadas
        });

    } catch (err) {

        console.error(
            '❌ Error en generación IA:',
            err
        );

        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ── ENDPOINT ADMIN: Cambiar tema guardando directamente en MongoDB ──────────────────────────
app.post('/admin/cambiar-tema', async (req, res) => {
    try {
        const { preguntas, evento_nombre, evento_subtitulo, emoji_1, emoji_2, emoji_3, url_publica } = req.body;

        if (!preguntas || !Array.isArray(preguntas) || preguntas.length < 10) {
            return res.status(400).json({ ok: false, error: 'Se necesitan al menos 10 preguntas.' });
        }
        if (!evento_nombre || !url_publica) {
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });
        }

        if (dbPreguntas && dbConfig) {
            await dbPreguntas.deleteMany({});
            await dbPreguntas.insertMany(preguntas);

            contenido.config.url_publica           = url_publica;
            contenido.evento.nombre                = evento_nombre;
            contenido.evento.subtitulo             = evento_subtitulo || evento_nombre;
            contenido.login.titulo                 = '¡' + evento_nombre + '!';
            contenido.leaderboard.titulo_principal = evento_nombre;
            contenido.resultados.url_reinicio       = url_publica;
            if (emoji_1 !== undefined) { contenido.evento.emoji_1 = emoji_1; contenido.evento.emoji_principal = emoji_1; }
            if (emoji_2 !== undefined) contenido.evento.emoji_2 = emoji_2;
            if (emoji_3 !== undefined) contenido.evento.emoji_3 = emoji_3;
            contenido.evento.emojis_header = [emoji_1, emoji_2, emoji_3].filter(Boolean).join(' ') || contenido.evento.emojis_header;

            await dbConfig.updateOne(
                { tipo: "contenido_actual" },
                { $set: { tipo: "contenido_actual", datos: contenido } },
                { upsert: true }
            );

            preguntasTodo = preguntas;

            console.log(`🔄 TEMA ACTUALIZADO EN MONGO ATLAS: "${evento_nombre}" | ${preguntas.length} preguntas.`);
            
            res.json({
                ok: true,
                mensaje: `Tema "${evento_nombre}" aplicado y guardado en la nube con éxito.`,
                preguntas_total: preguntas.length
            });
        } else {
            res.status(500).json({ ok: false, error: "La base de datos de MongoDB no está inicializada." });
        }

    } catch (err) {
        console.error('❌ Error al cambiar tema en la nube:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── ENDPOINT ADMIN: Actualizar solo configuración (sin tocar preguntas) ────────
app.post('/admin/actualizar-config', async (req, res) => {
    try {
        const { evento_nombre, evento_subtitulo, emoji_1, emoji_2, emoji_3, url_publica } = req.body;

        if (!evento_nombre || !url_publica) {
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });
        }

        contenido.config.url_publica           = url_publica;
        contenido.evento.nombre                = evento_nombre;
        contenido.evento.subtitulo             = evento_subtitulo || evento_nombre;
        contenido.login.titulo                 = '¡' + evento_nombre + '!';
        contenido.leaderboard.titulo_principal = evento_nombre;
        contenido.resultados.url_reinicio      = url_publica;
        if (emoji_1 !== undefined) contenido.evento.emoji_1 = emoji_1;
        if (emoji_2 !== undefined) contenido.evento.emoji_2 = emoji_2;
        if (emoji_3 !== undefined) contenido.evento.emoji_3 = emoji_3;
        contenido.evento.emojis_header = [emoji_1, emoji_2, emoji_3].filter(Boolean).join(' ') || contenido.evento.emojis_header;
        if (emoji_1) contenido.evento.emoji_principal = emoji_1;

        if (dbConfig) {
            await dbConfig.updateOne(
                { tipo: 'contenido_actual' },
                { $set: { tipo: 'contenido_actual', datos: contenido } },
                { upsert: true }
            );
        }

        console.log(`⚙️ CONFIG ACTUALIZADA: "${evento_nombre}" | emojis: ${contenido.evento.emojis_header} | emoji_principal: ${contenido.evento.emoji_principal}`);
        res.json({ ok: true, mensaje: `Configuración de "${evento_nombre}" guardada. Recargá las páginas para ver los cambios.`, debug: { nombre: contenido.evento.nombre, emoji_1: contenido.evento.emoji_1, emoji_principal: contenido.evento.emoji_principal } });

    } catch (err) {
        console.error('❌ Error al actualizar config:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── ENDPOINT ADMIN: Resetear config de Mongo (usa contenido.json local) ────────
app.post('/admin/reset-config', async (req, res) => {
    try {
        // Recargar contenido.json local
        const fs = require('fs');
        const contenidoLocal = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
        contenido = contenidoLocal;

        if (dbConfig) {
            await dbConfig.deleteOne({ tipo: 'contenido_actual' });
            console.log('🗑️ Documento contenido_actual eliminado de Mongo');
        }
        res.json({ ok: true, mensaje: 'Config reseteada al archivo local. Ahora usá "Confirmar y Aplicar" para guardar la nueva config.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── ENDPOINT ADMIN: Limpiar todos los jugadores ─────────────────────────────
app.post('/admin/reset-usuarios', async (req, res) => {
    try {
        jugadores = {};
        if (dbCollection) {
            await dbCollection.deleteMany({});
            console.log('🗑️ Colección de jugadores vaciada en MongoDB Atlas');
        }
        enviarRankingAClientes();
        res.json({ ok: true, mensaje: 'Lista de usuarios limpiada con éxito.' });
    } catch (err) {
        console.error('❌ Error al resetear usuarios:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// LOGICA CENTRAL DE COMUNICACIÓN EN VIVO (WebSockets)
io.on('connection', (socket) => {
    console.log('🔌 Nuevo cliente conectado:', socket.id);

    let listaAlConectar = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    socket.emit('update_ranking', listaAlConectar);

    socket.on('pedir_ranking_dashboard', () => {
        let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
        socket.emit('data_ranking_dashboard', listaCompleta);
    });

    socket.on('join_game', (username) => {
        const cleanUsername = username.toLowerCase().replace('@', '').trim();
        
        if (jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0; 
            jugadores[cleanUsername].socketId = socket.id;
        } else {
            jugadores[cleanUsername] = {
                username: cleanUsername,
                puntos: 0, 
                puntosRondaActual: 0, 
                vidas: 3,
                respondidas: [],
                combo: 0,
                socketId: socket.id
            };
        }
        
        socket.usernameClean = cleanUsername;
        guardarRankingEnNube(cleanUsername); 
        enviarRankingAClientes();
    });

    socket.on('get_pregunta', () => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        if (jugador.vidas <= 0 || jugador.respondidas.length >= 10) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit(jugador.vidas <= 0 ? 'game_over' : 'game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        const disponibles = preguntasTodo.filter(p => !jugador.respondidas.includes(p.id));
        if (disponibles.length === 0) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit('game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        const pregunta = disponibles[Math.floor(Math.random() * disponibles.length)];
        const opciones = [pregunta.correcta, ...pregunta.incorrectas].sort(() => Math.random() - 0.5);

        socket.emit('pregunta_data', {
            id: pregunta.id,
            pregunta: pregunta.pregunta,
            opciones: opciones,
            numeroPregunta: jugador.respondidas.length + 1
        });
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

        const pregunta = preguntasTodo.find(p => p.id === preguntaId);
        if (!pregunta) return;
        
        const esCorrecta = pregunta.correcta === respuesta;

        if (esCorrecta) {
            jugador.respondidas.push(preguntaId);
            jugador.combo += 1;

            let puntosBase = intento === 1 ? 10 : 5;
            let bonusTiempo = Math.max(0, Math.round(15 * Math.log(20 / (tiempoEmpleado + 1))));
            let puntosPregunta = puntosBase + bonusTiempo;

            let multiplicador = 1;
            if (jugador.combo === 3) multiplicador = 2;
            if (jugador.combo === 6) multiplicador = 4;
            if (jugador.combo === 9) multiplicador = 6;

            jugador.puntosRondaActual += puntosPregunta * multiplicador;

            if (jugador.puntosRondaActual > jugador.puntos) {
                jugador.puntos = jugador.puntosRondaActual;
            }

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

    socket.on('disconnect', () => {
        console.log('🔌 Usuario desconectado:', socket.id);
    });
});

function obtenerPuesto(username) {
    let listaOrdenada = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    let index = listaOrdenada.findIndex(j => j.username === username);
    return index !== -1 ? index + 1 : listaOrdenada.length;
}

function enviarRankingAClientes() {
    let lista = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    io.emit('update_ranking', lista);
    io.emit('data_ranking_dashboard', lista); 
}

function activarKeepAlive() {

    if (
        contenido &&
        contenido.config &&
        contenido.config.url_publica
    ) {

        const urlPeticion =
            contenido.config.url_publica;

        setInterval(() => {

            https
                .get(urlPeticion, () => {})
                .on('error', () => {
                    console.log(
                        'Ping KeepAlive fallido'
                    );
                });

        }, 300000);

    }
}

// INICIO DEL SERVIDOR
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor central corriendo en el puerto ${PORT}`);
});
