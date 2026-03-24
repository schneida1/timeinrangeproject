exports.handler = async function(event, context) {
  // 1. Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // 2. Parse the incoming request body
    const { messages, system, maxTokens } = JSON.parse(event.body);

    // 3. Grab your hidden API key from Netlify's environment variables
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured on server' }) };
    }

    // 4. Format the payload for Google
    const formattedMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const body = {
      contents: formattedMessages,
      generationConfig: { maxOutputTokens: maxTokens || 400 }
    };

    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    // 5. Make the secure request to Google
    const googleRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    const data = await googleRes.json();

    if (data.error) {
      return { statusCode: 500, body: JSON.stringify({ error: data.error.message }) };
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // 6. Send the successful response back to the frontend
    return {
      statusCode: 200,
      body: JSON.stringify({ text: replyText })
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
