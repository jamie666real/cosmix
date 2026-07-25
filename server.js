const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 3004;
const botToken = process.env.DISCORD_BOT_TOKEN || '';
const channelId = process.env.DISCORD_CHANNEL_ID || '';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildDiscordMessage(payload) {
  const lines = [
    'New report submitted from CosmixMC',
    '',
    `Player: ${payload.username || 'Unknown'}`,
    `Type: ${payload.type || 'Unknown'}`,
    `Description: ${payload.description || 'No description provided'}`,
  ];

  return lines.join('\n');
}

async function sendToDiscord(payload) {
  if (!botToken || !channelId) {
    throw new Error(
      'Discord bot credentials are not configured. Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID before starting the server.'
    );
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify({
      content: buildDiscordMessage(payload),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord rejected the request: ${response.status} ${errorText}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/report') {
    try {
      const bodyText = await parseBody(req);
      const params = new URLSearchParams(bodyText);
      const payload = {
        username: params.get('username') || '',
        type: params.get('type') || '',
        description: params.get('description') || '',
      };

      if (!payload.username.trim() || !payload.description.trim()) {
        sendJson(res, 400, { error: 'Please provide your username and a description.' });
        return;
      }

      await sendToDiscord(payload);

      sendJson(res, 200, {
        message: 'Report sent successfully. Staff will review it shortly.',
      });
    } catch (error) {
      console.error(error);
      sendJson(res, 502, {
        error: error.message || 'Unable to forward the report to Discord right now.',
      });
    }
    return;
  }

  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(requestPath).replace(/^([.]{1,2}[\/]+)/, '');
  const fullPath = path.join(rootDir, safePath);

  if (!fullPath.startsWith(rootDir)) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  serveFile(res, fullPath);
});

server.listen(port, host, () => {
  console.log(`CosmixMC server listening on http://${host}:${port}`);
  console.log('Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to forward reports to Discord.');
});
