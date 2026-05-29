const socket = io(); 

function joinGame() {
    const username = document.getElementById('usernameInput').value;
    if (!username) return alert("Ingresa un nombre");
    
    socket.emit('join_game', username);
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('gameScreen').style.display = 'block';
    
    // Pedir la primera pregunta
    socket.emit('get_pregunta');
}

socket.on('pregunta_data', (data) => {
    const container = document.getElementById('preguntaContainer');
    container.innerHTML = `
        <h3>${data.pregunta}</h3>
        ${data.opciones.map(op => `
            <button onclick="enviarRespuesta('${data.id}', '${op}')">${op}</button>
        `).join('')}
    `;
});

function enviarRespuesta(preguntaId, respuesta) {
    socket.emit('enviar_respuesta', { 
        preguntaId, 
        respuesta, 
        intento: 1, 
        tiempoEmpleado: 0 
    });
}
