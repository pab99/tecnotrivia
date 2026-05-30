app.post('/admin/generar-ia', async (req, res) => {
    try {

        const { tema } = req.body;

        if (!tema) {
            return res.status(400).json({
                ok: false,
                error: 'Falta especificar el tema de la trivia.'
            });
        }

        const promptFinal = `
Generá exactamente 50 preguntas de trivia en español sobre:

"${tema}"

IMPORTANTE:

- Respondé únicamente JSON.
- Sin markdown.
- Sin explicaciones.
- Sin texto adicional.
- Sin encabezados.

Formato EXACTO:

[
  {
    "id": 1,
    "pregunta": "Pregunta",
    "correcta": "Respuesta correcta",
    "incorrectas": [
      "Incorrecta 1",
      "Incorrecta 2",
      "Incorrecta 3"
    ]
  }
]

Generar exactamente 50 preguntas.
`;

        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

        if (!OPENROUTER_API_KEY) {
            throw new Error('OPENROUTER_API_KEY no configurada');
        }

        const modelos = [
            'qwen/qwen3-235b-a22b:free',
            'deepseek/deepseek-r1:free',
            'mistralai/mistral-small-3.2-24b-instruct:free'
        ];

        let contenidoIA = null;
        let ultimoError = '';

        for (const modelo of modelos) {

            console.log(`🤖 Probando ${modelo}`);

            const response = await fetch(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: modelo,
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

            if (response.ok) {

                const data = await response.json();

                contenidoIA =
                    data?.choices?.[0]?.message?.content || null;

                if (contenidoIA) {
                    console.log(`✅ Usando ${modelo}`);
                    break;
                }
            }

            ultimoError = await response.text();
        }

        if (!contenidoIA) {
            throw new Error(
                `Ningún modelo respondió correctamente. ${ultimoError}`
            );
        }

        contenidoIA = contenidoIA
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        const inicio = contenidoIA.indexOf('[');
        const fin = contenidoIA.lastIndexOf(']');

        if (inicio === -1 || fin === -1) {
            throw new Error('La IA no devolvió un array JSON válido');
        }

        contenidoIA =
            contenidoIA.substring(inicio, fin + 1);

        const preguntasValidadas =
            JSON.parse(contenidoIA);

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
