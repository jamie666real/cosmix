const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const rootDir = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 3006;
const defaultBotToken = 'MTUzMDY5MDUzMTQxMDE4NjI5MQ.GPbrGJ.Cak3Y4Xlt5alq0hZ_43R0RUlECiFJL4OwaJL7o';
const defaultChannelId = '1530629620276400258';
const defaultReportLogChannelId = '1530704575290413207';
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
const oauthSessions = new Map();
let rulesContent = [
  'Be respectful to other players and staff.',
  'No cheating, hacking, or exploiting bugs.',
  'Do not grief or destroy other players\' builds.',
  'Follow staff instructions at all times.',
];

function getOAuthConfig() {
  const clientId = (process.env.DISCORD_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.DISCORD_OAUTH_REDIRECT_URI || '').trim();
  const scopes = (process.env.DISCORD_OAUTH_SCOPES || 'identify email').trim();
  return { clientId, clientSecret, redirectUri, scopes };
}

function getSessionId(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|; )sessionId=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function getSession(req) {
  const sessionId = getSessionId(req);
  return sessionId ? oauthSessions.get(sessionId) || null : null;
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie', `sessionId=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sessionId=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function parsePermissions(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const normalized = new Set([...roles, ...permissions]);
  return {
    isStaff: normalized.has('staff') || normalized.has('admin') || normalized.has('moderator'),
    isAdmin: normalized.has('admin'),
    canManageReports: normalized.has('staff') || normalized.has('admin') || normalized.has('moderator'),
    raw: [...normalized],
  };
}

function buildOAuthRedirectUrl(state) {
  const { clientId, redirectUri, scopes } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    '1530713968614834246': state,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const { clientId, clientSecret } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId, '1530713968614834246': clientId,
    client_secret: clientSecret, mKN6BHvTKxDBwTfoxjBQhY24MPDI7NR8: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri, redirect_uri: 'http://local.host:3000/redirect'
  });

  const response = await fetch('https://discord.com/oauth2/authorize?client_id=1530713968614834246&response_type=code&redirect_uri=http%3A%2F%2Flocal.host%3A3000%2Fredirect&integration_type=0&scope=guilds.join+applications.commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord OAuth exchange failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord user lookup failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function getMinecraftServerStatus(host, port) {
  try {
    const response = await fetch(`https://api.mcsrvstat.us/2/${host}:${port}`, {
      headers: { 'User-Agent': 'CosmixMC-Report-Bridge/1.0' },
    });
    const data = await response.json();
    if (!data || !data.online) {
      return { online: false, players: 0 };
    }

    return {
      online: true,
      players: data.players?.online || 0,
      maxPlayers: data.players?.max || 0,
      version: data.version || 'Unknown',
      hostname: data.hostname || host,
      description: data.description || 'cosmixmc.org',
    };
  } catch (error) {
    return { online: false, players: 0 };
  }
}

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
  const botToken = (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || defaultBotToken).trim();
  const channelId = (process.env.DISCORD_CHANNEL_ID || process.env.DISCORD_CHANNEL || defaultChannelId).trim();
  const reportLogChannelId = (process.env.DISCORD_REPORT_LOG_CHANNEL_ID || process.env.DISCORD_LOG_CHANNEL_ID || defaultReportLogChannelId).trim();
  return { botToken, channelId, reportLogChannelId };
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

function buildActionRow(payload, disabled = false) {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: `claim:${payload.reportId}`, label: 'Claim', disabled },
      { type: 2, style: 2, custom_id: `close:${payload.reportId}`, label: 'Close', disabled },
      { type: 2, style: 3, custom_id: `close-reason:${payload.reportId}`, label: 'Close with reason', disabled },
      { type: 2, style: 2, custom_id: `resolve:${payload.reportId}`, label: 'Resolve', disabled },
      { type: 2, style: 3, custom_id: `resolve-reason:${payload.reportId}`, label: 'Resolve with reasoning', disabled },
    ],
  };
}

function buildDiscordPayload(payload) {
  return {
    content: payload.content || 'New report submitted from CosmixMC',
    embeds: [buildDiscordEmbed(payload)],
    allowed_mentions: {
      parse: [],
    },
  };
}

function buildApplicationCommandDefinitions() {
  return [
    {
      name: 'claim',
      description: 'Claim a submitted report',
      options: [
        {
          name: 'report_id',
          description: 'The report ID to claim',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'close',
      description: 'Close a report',
      options: [
        {
          name: 'report_id',
          description: 'The report ID to close',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'close-reason',
      description: 'Close a report with a reason',
      options: [
        {
          name: 'report_id',
          description: 'The report ID to close',
          type: 3,
          required: true,
        },
        {
          name: 'reason',
          description: 'The reason for closing the report',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'resolve',
      description: 'Resolve a report',
      options: [
        {
          name: 'report_id',
          description: 'The report ID to resolve',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'resolve-reason',
      description: 'Resolve a report with a reason',
      options: [
        {
          name: 'report_id',
          description: 'The report ID to resolve',
          type: 3,
          required: true,
        },
        {
          name: 'reason',
          description: 'The reason for resolving the report',
          type: 3,
          required: true,
        },
      ],
    },
  ];
}

function buildReportLogPayload(report, action, reason, actor, messageContent) {
  const actionLabel = action === 'submitted'
    ? 'submitted'
    : action === 'claimed'
      ? 'claimed'
      : action === 'closed'
        ? 'closed'
        : action === 'closed-reason'
          ? 'closed with reason'
          : action === 'resolved'
            ? 'resolved'
            : 'resolved with reason';

  const description = messageContent || `Report ${actionLabel} by ${actor || 'staff'}`;
  const fields = [
    { name: 'Report ID', value: truncate(report.reportId || 'Unknown') },
    { name: 'Status', value: truncate(actionLabel) },
    { name: 'Actor', value: truncate(actor || 'Staff') },
  ];

  if (reason) {
    fields.push({ name: 'Reason', value: truncate(reason) });
  }

  return {
    content: `Report ${report.reportId || 'Unknown'} log`,
    embeds: [
      {
        title: 'Report log',
        description,
        color: 0x2563eb,
        fields,
        footer: {
          text: `CosmixMC • ${new Date().toISOString()}`,
        },
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };
}

async function parseDiscordResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

async function setBotPresence() {
  const { botToken } = getDiscordConfig();

  if (!botToken) {
    return;
  }

  if (isPlaceholderDiscordValue(botToken)) {
    return;
  }

  try {
    const response = await fetch('https://discord.com/api/v10/users/@me/settings', {
      method: 'PATCH',
      headers: {
        Authorization: buildDiscordAuthHeader(botToken),
        'Content-Type': 'application/json',
        'User-Agent': 'CosmixMC-Report-Bridge/1.0',
      },
      body: JSON.stringify({
        status: 'dnd',
        custom_status: {
          text: 'CosmicMC Reporting',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Discord presence update failed: ${response.status} ${errorText}`);
    }
  } catch (error) {
    console.warn('Discord presence update skipped:', error.message || error);
  }
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
  const { botToken, channelId } = getDiscordConfig();

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

  return parseDiscordResponse(response);
}

async function postReportLog(report, action, reason, actor, messageContent) {
  const { botToken, reportLogChannelId } = getDiscordConfig();

  if (!botToken || !reportLogChannelId) {
    return;
  }

  if (isPlaceholderDiscordValue(botToken) || isPlaceholderDiscordValue(reportLogChannelId)) {
    return;
  }

  const payload = buildReportLogPayload(report, action, reason, actor, messageContent);
  const response = await fetch(`https://discord.com/api/v10/channels/${reportLogChannelId}/messages`, {
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
    throw new Error(`Discord report log failed: ${response.status} ${errorText}`);
  }
}

function formatEmailAction(action) {
  switch (action) {
    case 'closed-reason':
      return 'closed with reason';
    case 'resolved-reason':
      return 'resolved with reason';
    default:
      return action;
  }
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

  const actionLabel = formatEmailAction(action);
  const transcript = buildTranscript(report);
  const summary = reason ? `Reason: ${reason}` : 'Reason: No reason provided';
  const intro = reason
    ? `Your report has been ${actionLabel}.`
    : `Your report has been ${actionLabel}.`;

  await transporter.sendMail({
    from: smtpFrom,
    to: report.email,
    subject: `CosmixMC report update: ${report.reportId}`,
    text: `${intro}\n\n${summary}\n\nTranscript:\n${transcript}`,
  });
}

async function postTranscriptToDiscord(report) {
  const { botToken, channelId } = getDiscordConfig();

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

async function updateDiscordReport(report, action, reason, actor, messageContent) {
  const { botToken, channelId } = getDiscordConfig();

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
    embedTitle: action === 'claimed' ? 'Report claimed' : action.startsWith('closed') ? 'Report closed' : 'Report resolved',
    descriptionText: messageContent || `Staff action: ${statusText}`,
    color: action.startsWith('resolved') ? 0x16a34a : action.startsWith('closed') ? 0xdc2626 : 0x3b82f6,
    statusText,
    reason,
    content: messageContent || `Report ${action === 'claimed' ? 'claimed' : action.startsWith('resolved') ? 'resolved' : 'closed'} by ${actor || 'staff'}.`,
  };

  const actionPayload = buildDiscordPayload(payload, true);

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${report.discordMessageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(actionPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord update failed: ${response.status} ${errorText}`);
  }

  await postReportLog(report, action, reason, actor, messageContent);
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
              required: true,
            },
          ],
        },
      ],
    },
  };
}

function parseModalReason(components) {
  for (const row of components || []) {
    for (const component of row?.components || []) {
      if (component?.value !== undefined) {
        return component.value || '';
      }
    }
  }
  return '';
}

function getActorMention(interaction) {
  const user = interaction.member?.user || interaction.user || {};
  return user.id ? `<@${user.id}>` : (user.username || 'staff');
}

function getInteractionReportId(interaction) {
  if (interaction.data?.custom_id) {
    const [, , reportId] = interaction.data.custom_id.split(':') || [];
    return reportId || '';
  }

  const options = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const reportOption = options.find((option) => option?.name === 'report_id');
  return reportOption?.value ? String(reportOption.value) : '';
}

function getInteractionReason(interaction) {
  const options = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const reasonOption = options.find((option) => option?.name === 'reason');
  return reasonOption?.value ? String(reasonOption.value) : '';
}

async function registerApplicationCommands({ applicationId, guildId } = {}) {
  const { botToken } = getDiscordConfig();
  const resolvedApplicationId = applicationId || process.env.DISCORD_APPLICATION_ID || '';
  const resolvedGuildId = guildId || process.env.DISCORD_GUILD_ID || '';

  if (!botToken || !resolvedApplicationId) {
    return { registered: 0, skipped: true };
  }

  const endpoint = resolvedGuildId
    ? `https://discord.com/api/v10/applications/${resolvedApplicationId}/guilds/${resolvedGuildId}/commands`
    : `https://discord.com/api/v10/applications/${resolvedApplicationId}/commands`;

  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: buildDiscordAuthHeader(botToken),
      'Content-Type': 'application/json',
      'User-Agent': 'CosmixMC-Report-Bridge/1.0',
    },
    body: JSON.stringify(buildApplicationCommandDefinitions()),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord command registration failed: ${response.status} ${errorText}`);
  }

  return { registered: buildApplicationCommandDefinitions().length, skipped: false };
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
          sendJson(res, 200, { type: 5 });

          void (async () => {
            try {
              const actor = getActorMention(interaction);
              const reason = parseModalReason(interaction.data?.components || []);
              const report = reportsById.get(reportId);
              if (!report) {
                return;
              }

              const normalizedAction = action === 'close-reason' ? 'closed-reason' : 'resolved-reason';
              const messageContent = normalizedAction === 'closed-reason'
                ? `Report closed by ${actor} with reason: **${reason}**`
                : `Report resolved by ${actor} with reason: **${reason}**`;
              report.actions.push({ action: normalizedAction, actor: 'Staff', reason, timestamp: new Date().toISOString() });
              report.status = normalizedAction;
              report.reason = reason;
              await updateDiscordReport(report, normalizedAction, reason, actor, messageContent);
              await postTranscriptToDiscord(report);
              if (normalizedAction === 'closed-reason' || normalizedAction === 'resolved-reason') {
                await sendEmailReport(report, normalizedAction, reason);
              }
            } catch (error) {
              console.error(error);
            }
          })();
          return;
        }
      }

      if (interaction.type === 2) {
        const componentType = interaction.data?.component_type;
        if (componentType === 2) {
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

          const actor = getActorMention(interaction);
          sendJson(res, 200, { type: 5 });

          void (async () => {
            try {
              const normalizedAction = action === 'claim' ? 'claimed' : action === 'close' ? 'closed' : 'resolved';
              const messageContent = normalizedAction === 'claimed'
                ? `Report claimed by ${actor}`
                : normalizedAction === 'closed'
                  ? `Report closed by ${actor}`
                  : `Report resolved by ${actor}`;
              report.actions.push({ action: normalizedAction, actor: 'Staff', timestamp: new Date().toISOString() });
              report.status = normalizedAction;
              await updateDiscordReport(report, normalizedAction, '', actor, messageContent);
              await postTranscriptToDiscord(report);
              if (normalizedAction === 'closed' || normalizedAction === 'resolved') {
                await sendEmailReport(report, normalizedAction, '');
              }
            } catch (error) {
              console.error(error);
            }
          })();
          return;
        }

        const commandName = interaction.data?.name;
        if (commandName) {
          const reportId = getInteractionReportId(interaction);
          const report = reportsById.get(reportId);
          const actor = getActorMention(interaction);

          if (!reportId || !report) {
            sendJson(res, 200, { type: 4, data: { content: 'That report could not be found anymore.', flags: 64 } });
            return;
          }

          const reason = getInteractionReason(interaction);
          const normalizedAction = commandName === 'claim'
            ? 'claimed'
            : commandName === 'close'
              ? 'closed'
              : commandName === 'close-reason'
                ? 'closed-reason'
                : commandName === 'resolve'
                  ? 'resolved'
                  : 'resolved-reason';

          const messageContent = normalizedAction === 'claimed'
            ? `Report claimed by ${actor}`
            : normalizedAction === 'closed'
              ? `Report closed by ${actor}`
              : normalizedAction === 'closed-reason'
                ? `Report closed by ${actor} with reason: **${reason}**`
                : normalizedAction === 'resolved'
                  ? `Report resolved by ${actor}`
                  : `Report resolved by ${actor} with reason: **${reason}**`;

          sendJson(res, 200, { type: 4, data: { content: 'Processing report action...', flags: 64 } });

          void (async () => {
            try {
              report.actions.push({ action: normalizedAction, actor: 'Staff', reason, timestamp: new Date().toISOString() });
              report.status = normalizedAction;
              report.reason = reason || report.reason || '';
              await updateDiscordReport(report, normalizedAction, reason, actor, messageContent);
              await postTranscriptToDiscord(report);
              if (normalizedAction === 'closed' || normalizedAction === 'resolved' || normalizedAction === 'closed-reason' || normalizedAction === 'resolved-reason') {
                await sendEmailReport(report, normalizedAction, reason);
              }
            } catch (error) {
              console.error(error);
            }
          })();
          return;
        }
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

    if (req.method === 'GET' && url.pathname === '/api/server/status') {
      const host = url.searchParams.get('host') || 'mc.cosmixmc.org';
      const port = url.searchParams.get('port') || '25565';
      const status = await getMinecraftServerStatus(host, port);
      sendJson(res, 200, status);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/rules') {
      sendJson(res, 200, { rules: rulesContent });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const bodyText = await parseBody(req);
      const params = new URLSearchParams(bodyText);
      const rawRules = params.get('rules') || '';
      rulesContent = rawRules
        .split('\n')
        .map((rule) => rule.trim())
        .filter(Boolean);
      sendJson(res, 200, { rules: rulesContent });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/discord/login') {
      const { clientId } = getOAuthConfig();
      if (!clientId) {
        sendJson(res, 500, { error: 'Discord OAuth is not configured.' });
        return;
      }

      const state = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const redirectUrl = buildOAuthRedirectUrl(state);
      sendJson(res, 200, { redirectUrl, state });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/discord/callback') {
      try {
        const { clientId, redirectUri } = getOAuthConfig();
        if (!clientId || !redirectUri) {
          sendJson(res, 500, { error: 'Discord OAuth is not configured.' });
          return;
        }

        const params = url.searchParams;
        const code = params.get('code') || '';
        const state = params.get('state') || '';
        const error = params.get('error') || '';

        if (error) {
          sendJson(res, 400, { error: `Discord OAuth failed: ${error}` });
          return;
        }

        if (!code) {
          sendJson(res, 400, { error: 'Missing Discord OAuth code.' });
          return;
        }

        const tokenResponse = await exchangeCodeForToken(code, redirectUri);
        const discordUser = await fetchDiscordUser(tokenResponse.access_token);
        const permissions = parsePermissions(discordUser);
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        oauthSessions.set(sessionId, {
          id: sessionId,
          discordId: discordUser.id,
          username: discordUser.username,
          avatar: discordUser.avatar,
          email: discordUser.email || '',
          permissions,
          state,
          createdAt: new Date().toISOString(),
        });

        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `sessionId=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax`,
        });
        res.end();
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to complete Discord sign-in.' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const session = getSession(req);
      if (session) {
        oauthSessions.delete(session.id);
      }
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = getSession(req);
      if (!session) {
        sendJson(res, 200, { authenticated: false });
        return;
      }

      sendJson(res, 200, {
        authenticated: true,
        user: {
          id: session.discordId,
          username: session.username,
          email: session.email,
          avatar: session.avatar,
          permissions: session.permissions,
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/discord/commands/register') {
      try {
        const bodyText = await parseBody(req);
        let payload = {};
        try {
          payload = JSON.parse(bodyText);
        } catch (error) {
          payload = {};
        }

        const result = await registerApplicationCommands({
          applicationId: payload.applicationId || payload.application_id || process.env.DISCORD_APPLICATION_ID || '',
          guildId: payload.guildId || payload.guild_id || process.env.DISCORD_GUILD_ID || '',
        });

        sendJson(res, 200, result);
      } catch (error) {
        console.error(error);
        sendJson(res, 502, { error: error.message || 'Unable to register Discord commands.' });
      }
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
        await postReportLog(reportPayload, 'submitted', '', 'Reporter', 'Report submitted from web form');
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
    console.log('Open http://localhost:3006 in your browser or use the forwarded URL.');
    console.log('Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to forward reports to Discord.');
    void registerApplicationCommands({
      applicationId: process.env.DISCORD_APPLICATION_ID || '',
      guildId: process.env.DISCORD_GUILD_ID || '',
    }).catch((error) => {
      console.warn('Discord command registration skipped or failed:', error.message || error);
    });
    void setBotPresence();
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildApplicationCommandDefinitions,
  buildDiscordAuthHeader,
  buildDiscordEmbed,
  buildDiscordPayload,
  buildReportLogPayload,
  buildTranscript,
  parsePermissions,
  createReportId,
  parseDiscordResponse,
  startServer,
};
