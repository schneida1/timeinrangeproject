export default async (req) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    return Response.json(data);

  } catch (err) {
    return Response.json({ error: { message: err.message } }, { status: 500 });
  }
};

export const config = { path: '/api/claude' };
