const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb'); // Conector oficial de MongoDB

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Cargar configuración del evento desde contenido.json
const CONTENIDO_PATH = path.join(__dirname, 'contenido.json');
const contenido = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
const { mongo_db, mongo_col } = contenido.config;
console.log(`📋 Evento: ${contenido.evento.nombre} | BD: ${mongo_db} | Colección: ${mongo_col}`);

const PREGUNTAS_PATH = path.join(__dirname, 'preguntas.json');

// Cargar preguntas históricas de forma segura al arrancar
const preguntasTodo = JSON.parse(fs.readFileSync(PREGUNTAS_PATH, 'utf8'));

// CONFIGURACIÓN DE PERSISTENCIA (MongoDB Atlas)
const mongoUri = process.env.MONGO_URI; 
let dbCollection = null;
let jugadores = {}; // Se mantiene en memoria local para máxima velocidad de respuesta en el juego

// Función asíncrona para inicializar la conexión con la nube al arrancar
async function conectarBaseDeDatos() {
    if (!mongoUri) {
        console.log("⚠️ ALERTA: No se detectó la variable MONGO_URI en Render. El servidor funcionará de forma efímera en memoria.");
        return;
    }
    try {
        const client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db(mongo_db);       // Leído desde contenido.json
        dbCollection = db.collection(mongo_col); // Leído desde contenido.json
        console.log("🚀 CONECTADO EXITOSAMENTE A MONGO DB ATLAS");

        // Recuperar todo el historial guardado en la nube y volcarlo a la memoria
        const historialNube = await dbCollection.find({}).toArray();
        historialNube.forEach(jugador => {
            // Normalización preventiva para asegurar que no falte ningún campo clave
            if (jugador.puntos === undefined) jugador.puntos = 0;
            if (jugador.puntosRondaActual === undefined) jugador.puntosRondaActual = 0;
            if (!jugador.respondidas) jugador.respondidas = [];
            
            jugadores[jugador.username] = jugador;
        });
        console.log(`📦 BBDD SINCRONIZADA. Usuarios recuperados desde la nube: ${Object.keys(jugadores).length}`);
    } catch (error) {
        console.error("❌ Error crítico al conectar a MongoDB Atlas:", error.message);
    }
}

// Inicializamos la conexión
conectarBaseDeDatos();

// Guarda o actualiza de forma asíncrona los datos de un jugador en la nube
async function guardarRankingEnNube(username) {
    if (dbCollection && jugadores[username]) {
        try {
            // Hacemos una copia limpia del objeto en memoria para la BBDD
            const datosJugador = { ...jugadores[username] };
            delete datosJugador._id; // Quitamos el ID de Mongo de la estructura por si existiera conflicto
            
            // Reemplaza o inserta (upsert) el registro buscando por el campo único username
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

// Sirve el archivo de contenido/textos del evento (permite cambiar sin tocar el HTML)
app.get('/contenido.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'contenido.json'));
});

// Sirve los datos curiosos generados desde preguntas.json (rotativo en pantalla gigante)
app.get('/datos_curiosos.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'datos_curiosos.json'));
});

// Endpoint de emergencia por si requerís descargar un backup estático en JSON desde el Dashboard
app.get('/ranking_persistente.json', (req, res) => {
    let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    res.json(listaCompleta);
});

// LOGICA CENTRAL DE COMUNICACIÓN EN VIVO (WebSockets)
io.on('connection', (socket) => {
    console.log('🔌 Nuevo cliente conectado:', socket.id);

    // Enviar el ranking actual ni bien se conecta cualquier pantalla
    let listaAlConectar = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    socket.emit('update_ranking', listaAlConectar);

    // Solicitud explícita de datos desde el Dashboard de control o Pantalla de TV
    socket.on('pedir_ranking_dashboard', () => {
        let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
        socket.emit('data_ranking_dashboard', listaCompleta);
    });

    // Acción cuando un jugador ingresa su nombre e inicia el juego
    socket.on('join_game', (username) => {
        const cleanUsername = username.toLowerCase().replace('@', '').trim();
        
        // Si el jugador ya existía en el historial global, reiniciamos sus valores de la ronda actual
        if (jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0; 
            jugadores[cleanUsername].socketId = socket.id;
        } else {
            // Si es un jugador completamente nuevo en el evento
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
        
        // Guardamos en la nube asíncronamente y distribuimos el ranking actualizado en vivo
        guardarRankingEnNube(cleanUsername); 
        enviarRankingAClientes();
    });

    // Envío de preguntas dinámicas y aleatorias por participante
    socket.on('get_pregunta', () => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        // Validamos si perdió todas las vidas o si ya contestó el límite de la ronda (10 preguntas)
        if (jugador.vidas <= 0 || jugador.respondidas.length >= 10) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit(jugador.vidas <= 0 ? 'game_over' : 'game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        // Filtrar preguntas del JSON para no repetir las que el usuario ya respondió
        const disponibles = preguntasTodo.filter(p => !jugador.respondidas.includes(p.id));
        if (disponibles.length === 0) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit('game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        // Tomar una pregunta al azar de las disponibles y mezclar las opciones de respuesta
        const pregunta = disponibles[Math.floor(Math.random() * disponibles.length)];
        const opciones = [pregunta.correcta, ...pregunta.incorrectas].sort(() => Math.random() - 0.5);

        socket.emit('pregunta_data', {
            id: pregunta.id,
            pregunta: pregunta.pregunta,
            opciones: opciones,
            numeroPregunta: jugador.respondidas.length + 1
        });
    });

    // Procesamiento de las respuestas enviadas desde los celulares
    socket.on('enviar_respuesta', ({ preguntaId, respuesta, intento, tiempoEmpleado }) => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        // Caso especial: El temporizador del cliente llegó a cero
        if (respuesta === "__TIEMPO_AGOTADO__") {
            jugador.respondidas.push(preguntaId);
            jugador.vidas -= 1;
            jugador.combo = 0; // Rompe la racha de aciertos consecutivos
            
            socket.emit('resultado_respuesta', { correcta: false, tiempoAgotado: true, intento: 2, vidas: jugador.vidas });
            guardarRankingEnNube(cleanUsername);
            enviarRankingAClientes();
            return;
        }

        const pregunta = preguntasTodo.find(p => p.id === preguntaId);
        const esCorrecta = pregunta.correcta === respuesta;

        if (esCorrecta) {
            jugador.respondidas.push(preguntaId);
            jugador.combo += 1;

            // Puntuación base según el intento (10pts en el primero, 5pts en el segundo)
            let puntosBase = intento === 1 ? 10 : 5;
            
            // Bonus por velocidad usando un cálculo logarítmico basado en el tiempo empleado
            let bonusTiempo = Math.max(0, Math.round(15 * Math.log(20 / (tiempoEmpleado + 1))));
            let puntosPregunta = puntosBase + bonusTiempo;

            // Sistema de multiplicadores por racha (Combo)
            let multiplicador = 1;
            if (jugador.combo === 3) multiplicador = 2;
            if (jugador.combo === 6) multiplicador = 4;
            if (jugador.combo === 9) multiplicador = 6;

            jugador.puntosRondaActual += puntosPregunta * multiplicador;

            // Récord histórico personal: Si superó su puntaje máximo anterior, lo actualizamos
            if (jugador.puntosRondaActual > jugador.puntos) {
                jugador.puntos = jugador.puntosRondaActual;
            }

            socket.emit('resultado_respuesta', { correcta: true, puntos: jugador.puntosRondaActual, combo: jugador.combo });
        } else {
            // Si falló pero fue su primer intento, le damos la segunda oportunidad
            if (intento === 1) {
                socket.emit('resultado_respuesta', { correcta: false, intento: 1 });
            } else {
                // Si falló en el segundo intento, pierde una vida y se rompe el combo
                jugador.respondidas.push(preguntaId);
                jugador.vidas -= 1;
                jugador.combo = 0;
                socket.emit('resultado_respuesta', { correcta: false, intento: 2, vidas: jugador.vidas });
            }
        }
        
        guardarRankingEnNube(cleanUsername); 
        enviarRankingAClientes();
    });

    // Permite al usuario reiniciar la ronda desde la pantalla final para volver a jugar
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

// Función auxiliar para calcular el puesto en tiempo real de un usuario en el podio
function obtenerPuesto(username) {
    let listaOrdenada = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    let index = listaOrdenada.findIndex(j => j.username === username);
    return index !== -1 ? index + 1 : listaOrdenada.length;
}

// Función encargada de emitir la tabla general actualizada a todos los clientes enganchados
function enviarRankingAClientes() {
    let lista = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    io.emit('update_ranking', lista);
    io.emit('data_ranking_dashboard', lista); 
}

// INICIO DEL SERVIDOR WEB
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor central corriendo en el puerto ${PORT}`);
    
    // Auto-Ping interno (Keep-Alive) cada 5 minutos para mitigar que Render duerma el proceso por inactividad
    setInterval(() => {
        http.get(`http://localhost:${PORT}`, (res) => {}).on('error', (err) => {});
    }, 300000); 
});
