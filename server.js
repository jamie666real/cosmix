const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const rootDir = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 3006;
const defaultBotToken = 'MTUzMDY5MDUzMTQxMDE4NjI5MQ.Gcn0vw.kD-ll44xvrbtcpWH9Ga-N1BWBH-hpUDX67L8BQ';
const defaultChannelId = '1530629620276400258';
const defaultWebhookUrl = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1530688116870877385/loZbOsb5BQaUW_4wvtZ-49eBGmHK9prYzLtjOep9BAnDQbPqLngMLhf1eyVV1fC7LjtH';
const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_USER || 'cosmix@localhost';

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

const reportsById = new Map();
const reportsByMessageId = new Map();

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

function createReportId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPT-${stamp}-${suffix}`;
}

function getDiscordConfig() {
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || defaultWebhookUrl || '').trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || defaultBotToken).trim();
  const channelId = (process.env.DISCORD_CHANNEL_ID || process.env.DISCORD_CHANNEL || defaultChannelId).trim();
  return { webhookUrl, botToken, channelId };
}

function buildDiscordAuthHeader(token) {
  if (!token) {
    return '';
  }

  const normalizedToken = token.trim();
  if (normalizedToken.startsWith('Bot ') || normalizedToken.startsWith('Bearer ')) {
    return normalizedToken;
  }

  return `Bot ${normalizedToken}`;
}

function isPlaceholderDiscordValue(value) {
  return /^(your-(bot|channel)-token|your-channel-id|dummy|placeholder)$/i.test(value || '');
}

function truncate(value, limit = 1024) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildDiscordEmbed(payload) {
  const fields = [
    { name: 'Reporter', value: truncate(payload.username || 'Unknown'), inline: true },
    { name: 'Type', value: truncate(payload.type || 'Unknown'), inline: true },
    { name: 'Email', value: truncate(payload.email || 'Not provided'), inline: true },
    { name: 'Description', value: truncate(payload.description || 'No description provided') },
  ];

  if (payload.reason) {
    fields.push({ name: 'Reason', value: truncate(payload.reason) });
  }

  if (payload.statusText) {
    fields.push({ name: 'Status', value: truncate(payload.statusText) });
  }

  return {
    title: payload.embedTitle || 'New report submitted',
    description: payload.descriptionText || 'A report has been submitted from the CosmixMC web form.',
    color: payload.color || 0xf59e0b,
    fields,
    footer: {
      text: `Report ID: ${payload.reportId || 'Unknown'}`,
    },
    timestamp: new Date().toISOString(),
  };
}

function buildActionRow(payload) {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: `claim:${payload.reportId}`, label: 'Claim' },
      { type: 2, style: 2, custom_id: `close:${payload.reportId}`, label: 'Close' },
      { type: 2, style: 3, custom_id: `close-reason:${payload.reportId}`, label: 'Close with reason' },
      { type: 2, style: 2, custom_id: `resolve:${payload.reportId}`, label: 'Resolve' },
      { type: 2, style: 3, custom_id: `resolve-reason:${payload.reportId}`, label: 'Resolve with reasoning' },
    ],
  };
}

function buildDiscordPayload(payload) {
  return {
    content: 'New report submitted from CosmixMC',
    embeds: [buildDiscordEmbed(payload)],
    components: [buildActionRow(payload)],
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildTranscript(payload) {
  const lines = [
    `Report ID: ${payload.reportId || 'Unknown'}`,
    `Reporter: ${payload.username || 'Unknown'}`,
    `Type: ${payload.type || 'Unknown'}`,
    `Email: ${payload.email || 'Not provided'}`,
    `Description: ${payload.description || 'No description provided'}`,
    'Timeline:',
  ];

  const actions = Array.isArray(payload.actions) && payload.actions.length > 0 ? payload.actions : [{ action: 'submitted', actor: 'Reporter' }];
  actions.forEach((entry, index) => {
    const reason = entry.reason ? ` — Reason: ${entry.reason}` : '';
    lines.push(`${index + 1}. ${entry.action} by ${entry.actor || 'Staff'}${reason}`);
  });

  return lines.join('\n');
}

async function sendToDiscord(payload) {
  const { webhookUrl, botToken, channelId } = getDiscordConfig();

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CosmixMC-Report-Bridge/1.0',
      },
      body: JSON.stringify(buildDiscordPayload(payload)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Discord webhook rejected the request: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  if (!botToken || !channelId) {
    throw new Error(
      'Discord bot credentials are not configured. Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID before starting the server.'
    );
  }

  if (isPlaceholderDiscordValue(botToken) || isPlaceholderDiscordValue(channelId)) {
    throw new Error('Discord credentials still contain placeholder values. Replace the token and channel ID with real values before sending a report.');
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildDiscordPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = response.status === 401
      ? 'The supplied Discord bot token is invalid or the bot is not authorized for that channel. Invite the bot and give it Send Messages permission.'
      : `Discord rejected the request: ${response.status} ${errorText}`;
    throw new Error(message);
  }

  return response.json();
}

async function sendEmailReport(report, action, reason) {
  if (!report.email || !report.email.trim()) {
    return;
  }

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('SMTP credentials are not fully configured. Skipping email delivery.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  const actionLabel = action === 'submitted' ? 'submitted' : action;
  const transcript = buildTranscript(report);
  const summary = reason ? `Reason: ${reason}` : 'Reason: No reason provided';

  await transporter.sendMail({
    from: smtpFrom,
    to: report.email,
    subject: `CosmixMC report update: ${report.reportId}`,
    text: `Your report has been ${actionLabel}.\n\n${summary}\n\nTranscript:\n${transcript}`,
  });
}

async function postTranscriptToDiscord(report) {
  const { webhookUrl, botToken, channelId } = getDiscordConfig();

  if (!botToken || !channelId) {
    return;
  }

  if (isPlaceholderDiscordValue(botToken) || isPlaceholderDiscordValue(channelId)) {
    return;
  }

  const payload = {
    content: `Transcript for ${report.reportId}`,
    embeds: [
      {
        title: 'Report transcript',
        description: 'The latest staff action and transcript are recorded below.',
        color: 0x2563eb,
        fields: [{ name: 'Transcript', value: truncate(buildTranscript(report), 4000) }],
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CosmixMC-Report-Bridge/1.0',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Discord transcript webhook post failed: ${response.status}`);
    }

    return;
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord transcript post failed: ${response.status} ${errorText}`);
  }
}

async function updateDiscordReport(report, action, reason) {
  const { webhookUrl, botToken, channelId } = getDiscordConfig();

  if (!botToken || !channelId) {
    return;
  }

  if (isPlaceholderDiscordValue(botToken) || isPlaceholderDiscordValue(channelId)) {
    return;
  }

  const statusText = action === 'claimed'
    ? 'Claimed by staff'
    : action === 'closed'
      ? 'Closed'
      : action === 'closed-reason'
        ? 'Closed with reason'
        : action === 'resolved'
          ? 'Resolved'
          : 'Resolved with reason';

  const payload = {
    ...report,
    embedTitle: 'Report updated',
    descriptionText: `Staff action: ${statusText}`,
    color: action.startsWith('resolved') ? 0x16a34a : action.startsWith('closed') ? 0xdc2626 : 0x3b82f6,
    statusText,
    reason,
  };

  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CosmixMC-Report-Bridge/1.0',
      },
      body: JSON.stringify(buildDiscordPayload(payload)),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook update rejected: ${response.status}`);
    }

    return;
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${report.discordMessageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildDiscordPayload(payload)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord update failed: ${response.status} ${errorText}`);
  }
}

function buildModalPayload(action, reportId) {
  const titles = {
    'close-reason': 'Add close reason',
    'resolve-reason': 'Add resolution reason',
  };

  return {
    type: 9,
    data: {
      custom_id: `modal:${action}:${reportId}`,
      title: titles[action] || 'Add a reason',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: `reason:${action}:${reportId}`,
              style: 2,
              label: 'Reason',
              placeholder: 'Explain the outcome or reasoning for this action.',
              required: false,
            },
          ],
        },
      ],
    },
  };
}

function parseModalReason(components) {
  const firstRow = components?.[0];
  const input = firstRow?.components?.[0];
  return input?.value || '';
}

async function handleInteraction(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const interaction = JSON.parse(body);

      if (!interaction || interaction.type === 1) {
        sendJson(res, 200, { type: 1 });
        return;
      }

      if (interaction.type === 3) {
        const [kind, action, reportId] = interaction.data?.custom_id?.split(':') || [];
        if (kind === 'modal') {
          const reason = parseModalReason(interaction.data?.components || []);
          const report = reportsById.get(reportId);
          if (!report) {
            sendJson(res, 200, { type: 4, data: { content: 'That report could not be found anymore.', flags: 64 } });
            return;
          }

          const normalizedAction = action === 'close-reason' ? 'closed-reason' : 'resolved-reason';
          report.actions.push({ action: normalizedAction, actor: 'Staff', reason, timestamp: new Date().toISOString() });
          report.status = normalizedAction;
          report.reason = reason;
          await updateDiscordReport(report, normalizedAction, reason);
          await postTranscriptToDiscord(report);
          await sendEmailReport(report, normalizedAction, reason);

          sendJson(res, 200, { type: 4, data: { content: 'Report action recorded.', flags: 64 } });
          return;
        }
      }

      if (interaction.type === 2) {
        const [action, reportId] = interaction.data?.custom_id?.split(':') || [];
        const report = reportsById.get(reportId);
        if (!report) {
          sendJson(res, 200, { type: 4, data: { content: 'That report could not be found anymore.', flags: 64 } });
          return;
        }

        if (action === 'close-reason' || action === 'resolve-reason') {
          sendJson(res, 200, buildModalPayload(action, reportId));
          return;
        }

        const normalizedAction = action === 'claim' ? 'claimed' : action === 'close' ? 'closed' : 'resolved';
        report.actions.push({ action: normalizedAction, actor: 'Staff', timestamp: new Date().toISOString() });
        report.status = normalizedAction;
        await updateDiscordReport(report, normalizedAction, '');
        await postTranscriptToDiscord(report);
        await sendEmailReport(report, normalizedAction, '');

        sendJson(res, 200, { type: 4, data: { content: 'Report action recorded.', flags: 64 } });
        return;
      }

      sendJson(res, 200, { type: 4, data: { content: 'Unsupported interaction.', flags: 64 } });
    } catch (error) {
      console.error(error);
      sendJson(res, 200, { type: 4, data: { content: 'Unable to process the report action.', flags: 64 } });
    }
  });
}

async function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/discord/interactions') {
      await handleInteraction(req, res);
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
          email: params.get('email') || '',
        };

        if (!payload.username.trim() || !payload.description.trim()) {
          sendJson(res, 400, { error: 'Please provide your username and a description.' });
          return;
        }

        const reportId = createReportId();
        const reportPayload = {
          ...payload,
          reportId,
          actions: [{ action: 'submitted', actor: 'Reporter', timestamp: new Date().toISOString() }],
          status: 'submitted',
          reason: '',
        };

        const discordMessage = await sendToDiscord(reportPayload);
        reportPayload.discordMessageId = discordMessage.id;
        reportPayload.discordChannelId = discordMessage.channel_id;
        reportsById.set(reportId, reportPayload);
        reportsByMessageId.set(discordMessage.id, reportPayload);

        await sendEmailReport(reportPayload, 'submitted', '');

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

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildDiscordAuthHeader,
  buildDiscordEmbed,
  buildDiscordPayload,
  buildTranscript,
  createReportId,
  startServer,
};
