'use strict';
// Adaptador YCloud + TRAVA DE CLIENTE NOVO para o bot.
// - Traduz eventos do YCloud para o formato da Meta (o bot continua igual) e as respostas do bot para a API do YCloud.
// - TRAVA (padrão = NEGAR, falha = NEGAR): o bot só fala com número que (a) está na lista de testes/equipe, ou
//   (b) já foi admitido como novo (chegou pelo site ou por anúncio) e nunca tem histórico no arquivo.
//   Cliente antigo = qualquer número com mensagem anterior no arquivo do WhatsApp -> bloqueado para sempre.
//   Se o arquivo não responde, ninguém novo é admitido e nenhuma resposta sai para quem não está admitido.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const digits = v => String(v || '').replace(/\D/g, '');
// compara telefones ignorando o 9º dígito brasileiro
const chave = v => { const d = digits(v); return d.startsWith('55') && d.length === 13 ? d.slice(0, 4) + d.slice(5) : d; };
const lista = v => String(v || '').split(',').map(digits).filter(Boolean);

module.exports = function criar(opt) {
  const E = opt.env || process.env;
  const log = opt.log || console.log;
  const axios = opt.axios;
  const pool = opt.pool || null;
  const API = E.YCLOUD_API_BASE || 'https://api.ycloud.com/v2';
  const KEY = E.YCLOUD_API_KEY || '';
  const NUM_AV = digits(E.YCLOUD_NUMBER_AVISOS || ''); // número do Instituto como NOTIFICADOR: avisos para a equipe saem por ele e os comandos (#parar, #iniciar...) chegam nele
  const NUM = digits(E.YCLOUD_NUMBER || ''); // número do Instituto (remetente) — eventos de outros números são ignorados
  const SEGREDO = E.YCLOUD_WEBHOOK_SECRET || '';
  const ARQUIVO_URL = (E.GUARD_ARQUIVO_URL || '').replace(/\/$/, '');
  const GUARD_TOKEN = E.GUARD_TOKEN || '';
  const RE_SITE = new RegExp(E.SITE_REGEX || 'vim atrav[eé]s do site', 'i');
  const fixosTeste = () => new Set(lista(E.TESTE_FONES || '5517997436206').map(chave)); // número de teste do dono: sempre ativo, mesmo com #parar
  const testers = () => new Set([...lista(E.GUARD_TESTERS).map(chave), ...fixosTeste()]); // só estes + admitidos são atendidos em modo teste
  const MODO_TESTE = String(E.GUARD_MODO_TESTE || '') === '1'; // 1 = só atende a lista de testes (ninguém mais é admitido)
  const extraPermitidos = opt.extraPermitidos || (async () => []); // números da equipe (alertas)
  const mediaDir = opt.mediaDir;
  const publicBase = opt.publicBase;
  const enabled = !!KEY;

  const novos = new Map(); // chave -> 'novo' | 'bloqueado'
  const enviados = new Set(); // wamid / id de mensagens enviadas pelo bot (para não confundir com eco humano)
  const histLocal = new Set(); // números vistos em eventos de histórico/echo desta execução

  async function iniciaTabela() {
    if (!pool) return;
    await pool.query(`create table if not exists guard_phones (
      phone text primary key, status text not null, origem text, motivo text,
      criado_em timestamptz not null default now())`);
    const r = await pool.query('select phone,status from guard_phones');
    for (const x of r.rows) novos.set(x.phone, x.status);
  }
  async function grava(phone, status, origem, motivo) {
    const k = chave(phone); novos.set(k, status);
    if (pool) await pool.query(`insert into guard_phones(phone,status,origem,motivo) values($1,$2,$3,$4)
      on conflict(phone) do update set status=excluded.status, origem=coalesce(excluded.origem,guard_phones.origem), motivo=excluded.motivo`,
      [k, status, origem || null, motivo || null]).catch(e => log('guard grava:', e.message));
  }

  // consulta o arquivo: o número já tinha conversa ANTES desta mensagem?
  async function conhecidoNoArquivo(phone, wamid, quando) {
    if (!ARQUIVO_URL || !GUARD_TOKEN) throw new Error('arquivo não configurado');
    const r = await axios.get(ARQUIVO_URL + '/guard/conhecido', {
      params: { phone: digits(phone), exclui: wamid || '', ate: quando || '' },
      headers: { 'X-Guard-Token': GUARD_TOKEN }, timeout: 6000, validateStatus: () => true });
    if (r.status !== 200 || typeof r.data.conhecido !== 'boolean') throw new Error('arquivo respondeu ' + r.status);
    return { conhecido: r.data.conhecido, salvo: r.data.salvo === true };
  }

  // decisão de ENTRADA. Retorna {ok, motivo}. Qualquer dúvida/erro => ok:false.
  async function decide(phone, msg) {
    try {
      const k = chave(phone);
      if (testers().has(k)) return { ok: true, motivo: 'teste' };
      if (MODO_TESTE) return { ok: false, motivo: 'modo teste: número fora da lista' };
      if (histLocal.has(k)) return { ok: false, motivo: 'visto em histórico/eco' };
      const st = novos.get(k);
      if (st === 'bloqueado') return { ok: false, motivo: 'cliente antigo (bloqueado)' };
      if (st === 'novo') return { ok: true, motivo: 'novo admitido' };
      // desconhecido do bot: precisa (1) não ter histórico no arquivo e (2) ter origem comprovada
      const quando = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : '';
      const ar = await conhecidoNoArquivo(phone, msg.id, quando);
      if (ar.conhecido) { await grava(phone, 'bloqueado', null, 'tinha histórico no arquivo'); return { ok: false, motivo: 'cliente antigo (arquivo)' }; }
      if (ar.salvo) { await grava(phone, 'bloqueado', null, 'contato salvo na agenda'); return { ok: false, motivo: 'contato salvo na agenda do Paulo' }; }
      const texto = (msg.text && msg.text.body) || '';
      // sem histórico e fora da agenda = contato novo; vindo do site/anúncio ou direto no número
      const origem = msg.referral ? 'anuncio' : (RE_SITE.test(texto) ? 'site' : 'direto');
      await grava(phone, 'novo', origem, 'admitido');
      return { ok: true, motivo: 'novo via ' + origem };
    } catch (e) {
      return { ok: false, motivo: 'falha na verificação (' + e.message + ') — negado' };
    }
  }

  // decisão de SAÍDA (segunda camada: vale para follow-ups, alertas, qualquer envio)
  async function podeEnviar(to) {
    const k = chave(to);
    if (testers().has(k)) return true;
    if (opt.ehAdmin && opt.ehAdmin(to)) return true; // quem administra o bot recebe as confirmações dos comandos
    if (novos.get(k) === 'novo' && !MODO_TESTE) return true;
    try { if ((await extraPermitidos()).map(chave).includes(k)) return true; } catch (e) {}
    return false;
  }

  // ---------- eventos YCloud -> formato Meta ----------
  const unix = s => { const t = Date.parse(s || ''); return String(Math.floor((isNaN(t) ? Date.now() : t) / 1000)); };
  function metaDeInbound(m, nome) {
    const from = digits(m.from);
    const msg = { from, id: m.wamid || m.id, timestamp: unix(m.sendTime), type: m.type };
    if (m.referral) msg.referral = m.referral;
    if (m.context && (m.context.id || m.context.message_id)) msg.context = { id: m.context.id || m.context.message_id };
    for (const t of ['text', 'image', 'document', 'audio', 'video', 'sticker', 'button', 'interactive', 'reaction', 'location', 'contacts']) {
      if (m[t] !== undefined) msg[t] = m[t];
    }
    if (msg.type === 'text' && !msg.text) msg.text = { body: '' };
    for (const t of ['image', 'document', 'audio']) {
      if (msg[t]) { const x = Object.assign({}, msg[t]); if (x.link) x.id = 'yc:' + Buffer.from(x.link).toString('base64url'); if (x.mime_type === undefined && x.mimeType) x.mime_type = x.mimeType; msg[t] = x; }
    }
    return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      contacts: [{ wa_id: from, profile: { name: (nome || '') } }], messages: [msg] } }] }] };
  }
  function metaDeStatus(w) {
    const st = { id: w.wamid || w.id, status: w.status, recipient_id: digits(w.to) };
    if (w.status === 'failed') st.errors = [{ code: w.errorCode, title: 'falha', message: w.errorMessage || '' }];
    return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [st] } }] }] };
  }

  // Interpreta um evento. Retorna {acao:'ignorar'|'mensagem'|'status'|'eco', ...}
  function interpreta(evt) {
    const t = evt && evt.type;
    if (t === 'whatsapp.inbound_message.received') {
      const m = evt.whatsappInboundMessage || {};
      if (NUM_AV && digits(m.to) === NUM_AV) { const nomeA = m.customerProfile && m.customerProfile.name; return { acao: 'avisos', phone: digits(m.from), msg: metaDeInbound(m, nomeA).entry[0].changes[0].value.messages[0] }; }
      if (NUM && digits(m.to) !== NUM) return { acao: 'ignorar', motivo: 'outro número (' + digits(m.to).slice(-4) + ')' };
      const nome = evt.whatsappInboundMessage && evt.whatsappInboundMessage.customerProfile && evt.whatsappInboundMessage.customerProfile.name;
      return { acao: 'mensagem', phone: digits(m.from), msg: metaDeInbound(m, nome || (m.customerProfile && m.customerProfile.name)).entry[0].changes[0].value.messages[0], nome };
    }
    if (t === 'whatsapp.message.updated') {
      const w = evt.whatsappMessage || {};
      if (NUM && digits(w.from) !== NUM) return { acao: 'ignorar', motivo: 'status de outro número' };
      return { acao: 'status', meta: metaDeStatus(w) };
    }
    if (t === 'whatsapp.smb.message.echoes') {
      const w = evt.whatsappMessage || {};
      if (NUM && digits(w.from) !== NUM) return { acao: 'ignorar', motivo: 'eco de outro número' };
      if (enviados.has(w.wamid) || enviados.has(w.id)) return { acao: 'ignorar', motivo: 'eco do próprio bot' };
      return { acao: 'eco', phone: digits(w.to) };
    }
    if (t === 'whatsapp.smb.history' || t === 'whatsapp.smb.app.state.sync') {
      const w = evt.whatsappInboundMessage || evt.whatsappMessage || {};
      for (const n of [w.from, w.to]) if (n && digits(n) !== NUM) histLocal.add(chave(n));
      return { acao: 'ignorar', motivo: 'histórico' };
    }
    return { acao: 'ignorar', motivo: 'tipo ' + t };
  }
  function marcaEco(phone) { histLocal.add(chave(phone)); }

  function assinaturaOk(cab, bruto) {
    if (!SEGREDO) return false; // sem segredo configurado, nada é aceito
    try {
      const m = /t=(\d+),s=([0-9a-f]+)/i.exec(cab || ''); if (!m) return false;
      const esp = crypto.createHmac('sha256', SEGREDO).update(m[1] + '.').update(bruto).digest('hex');
      return esp.length === m[2].length && crypto.timingSafeEqual(Buffer.from(esp), Buffer.from(m[2].toLowerCase()));
    } catch (e) { return false; }
  }

  // ---------- envio: Meta -> YCloud ----------
  const H = () => ({ 'X-API-Key': KEY, 'Content-Type': 'application/json' });
  function urlDeId(id) {
    const s = String(id || '');
    if (s.startsWith('file:')) return publicBase + '/media/' + s.slice(5).replace(/[^\w.-]/g, '');
    return null;
  }
  async function enviar(body, origGet, origPost) {
    if (body.status === 'read') { // marcar como lido / digitando
      const id = body.message_id; if (!id) return { data: {} };
      await origPost(`${API}/whatsapp/inboundMessages/${encodeURIComponent(id)}/markAsRead`, {}, { headers: H(), timeout: 8000 }).catch(() => {});
      if (body.typing_indicator) await origPost(`${API}/whatsapp/inboundMessages/${encodeURIComponent(id)}/typingIndicator`, {}, { headers: H(), timeout: 8000 }).catch(() => {});
      return { data: {} };
    }
    const to = digits(body.to);
    if (opt.parado && opt.parado() && !(opt.manual && opt.manual()) && !(opt.ehAdmin && opt.ehAdmin(to)) && !fixosTeste().has(chave(to))) { log(`⏸️ Bot parado (#parar): envio para ${to.slice(0, 4)}…${to.slice(-4)} bloqueado`); const e = new Error('bot parado'); e.response = { data: { bloqueado: true } }; throw e; }
    if (!(await podeEnviar(to))) { log(`🔒 TRAVA: envio para ${to.slice(0, 4)}…${to.slice(-4)} BLOQUEADO (não é cliente novo admitido)`); const e = new Error('bloqueado pela trava de cliente novo'); e.response = { data: { bloqueado: true } }; throw e; }
    const deAviso = !!(NUM_AV && opt.aviso && opt.aviso()); // avisos para a equipe saem pelo número do Instituto
    const y = { from: '+' + (deAviso ? NUM_AV : NUM), to: '+' + to, type: body.type };
    if (body.context && body.context.message_id) y.context = { message_id: body.context.message_id };
    switch (body.type) {
      case 'text': y.text = { body: body.text.body, previewUrl: !!body.text.preview_url }; break; // sem miniatura de link, a não ser quando pedido
      case 'interactive': y.interactive = body.interactive; break;
      case 'contacts': y.contacts = body.contacts; break;
      case 'image': case 'document': case 'audio': case 'video': {
        const x = Object.assign({}, body[body.type]); if (x.id && !x.link) { x.link = urlDeId(x.id); delete x.id; }
        if (!x.link) throw new Error('mídia sem link'); y[body.type] = x; break; }
      default: y[body.type] = body[body.type];
    }
    const r = await origPost(`${API}/whatsapp/messages`, y, { headers: H(), timeout: 20000 });
    const d = r.data || {}; const id = d.wamid || d.id;
    if (d.wamid) enviados.add(d.wamid); if (d.id) enviados.add(d.id);
    return { data: { messaging_product: 'whatsapp', messages: [{ id }] }, status: r.status };
  }

  // Liga o adaptador: intercepta as chamadas ao graph.facebook.com (axios e fetch) do bot.
  function instala() {
    const oPost = axios.post.bind(axios), oGet = axios.get.bind(axios);
    axios.post = async function (url, body, cfg) {
      if (typeof url === 'string' && url.includes('graph.facebook.com')) {
        if (/\/messages$/.test(url)) return enviar(body || {}, oGet, oPost);
        log('graph ignorado no modo YCloud:', url.replace(/\d{6,}/g, 'N')); const e = new Error('graph indisponível no modo YCloud'); e.response = { data: {} }; throw e;
      }
      return oPost(url, body, cfg);
    };
    axios.get = async function (url, cfg) {
      if (typeof url === 'string' && url.includes('graph.facebook.com')) {
        const id = url.split('/').pop().split('?')[0];
        if (id.startsWith('yc:')) return { data: { url: Buffer.from(id.slice(3), 'base64url').toString(), mime_type: '' } };
        const e = new Error('graph indisponível no modo YCloud'); e.response = { data: {} }; throw e;
      }
      if (typeof url === 'string' && /ycloud\.com/.test(url)) { cfg = Object.assign({}, cfg, { headers: Object.assign({}, (cfg || {}).headers, { 'X-API-Key': KEY }) }); delete cfg.headers.Authorization; }
      return oGet(url, cfg);
    };
    const oFetch = global.fetch;
    global.fetch = async function (url, init) {
      if (typeof url === 'string' && url.includes('graph.facebook.com') && /\/media$/.test(url)) {
        const f = init && init.body && init.body.get && init.body.get('file');
        if (!f) return { ok: false, json: async () => ({ error: 'sem arquivo' }) };
        const nome = crypto.randomBytes(16).toString('hex') + '.' + ((path.extname(f.name || '') || '.bin').slice(1) || 'bin').replace(/[^\w]/g, '');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, nome), Buffer.from(await f.arrayBuffer()));
        setTimeout(() => fs.unlink(path.join(mediaDir, nome), () => {}), 3600e3).unref();
        return { ok: true, json: async () => ({ id: 'file:' + nome }) };
      }
      return oFetch(url, init);
    };
  }

  const isTester = ph => testers().has(chave(ph));
  const ehFixoTeste = ph => fixosTeste().has(chave(ph));
  return { isTester, ehFixoTeste, enabled, instala, iniciaTabela, decide, podeEnviar, interpreta, marcaEco, assinaturaOk, grava, chave, _estado: { novos, enviados, histLocal } };
};
