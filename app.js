/* Europa 26/27 — app offline com sincronização */
(function () {
  'use strict';
  const T = window.TRIP, CFG = window.APP_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CITY = Object.fromEntries(T.cities.map(c => [c.id, c]));
  const CURRENCIES = ['EUR', 'GBP', 'CZK', 'PLN', 'HUF', 'BRL'];

  /* ---------------- armazenamento local ---------------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('eu26:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('eu26:' + k, JSON.stringify(v)); } catch (e) { toast('Memória do celular cheia'); } }
  };
  let items = LS.get('items', {});          // key -> {value, deleted, updated_at, device, dirty}
  const settings = Object.assign({ device: '', secret: '', url: '', key: '', trip: '' }, LS.get('settings', {}));
  const cfg = () => ({
    url: (settings.url || CFG.supabaseUrl || '').replace(/\/$/, ''),
    key: settings.key || CFG.supabaseAnonKey || '',
    trip: settings.trip || CFG.tripId || 'europa2026'
  });
  const syncConfigured = () => { const c = cfg(); return /^https:\/\//.test(c.url) && c.key && !/AQUI/.test(c.key) && settings.secret; };

  function getItem(k) { const it = items[k]; return it && !it.deleted ? it.value : undefined; }
  function setItem(k, v, del = false) {
    items[k] = { value: del ? null : v, deleted: del, updated_at: new Date().toISOString(), device: settings.device || '?', dirty: true };
    LS.set('items', items); scheduleSync(1500); updateDot();
  }
  const prefix = p => Object.keys(items).filter(k => k.startsWith(p) && !items[k].deleted).map(k => [k, items[k].value]);

  /* ---------------- sincronização (Supabase RPC) ---------------- */
  let syncTimer = null, syncing = false, lastErr = '';
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
  async function rpc(fn, body) {
    const c = cfg();
    const r = await fetch(c.url + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { const t = await r.text(); throw new Error(/senha/.test(t) ? 'Senha da viagem incorreta' : 'Erro ' + r.status); }
    return r.json();
  }
  async function sync() {
    if (syncing || !navigator.onLine || !syncConfigured()) { updateDot(); return; }
    syncing = true; updateDot();
    const c = cfg();
    try {
      const dirty = Object.entries(items).filter(([, v]) => v.dirty);
      if (dirty.length) {
        await rpc('viagem_push', { p_trip: c.trip, p_secret: settings.secret,
          p_rows: dirty.map(([k, v]) => ({ key: k, value: v.value, deleted: v.deleted, updated_at: v.updated_at, device: v.device })) });
        dirty.forEach(([k, v]) => { if (items[k] && items[k].updated_at === v.updated_at) items[k].dirty = false; });
      }
      const since = LS.get('lastPull', null);
      const sinceSafe = since ? new Date(new Date(since).getTime() - 120000).toISOString() : null;
      const rows = await rpc('viagem_pull', { p_trip: c.trip, p_secret: settings.secret, p_since: sinceSafe });
      let maxS = since, changed = false;
      for (const r of rows) {
        const cur = items[r.key];
        if (!cur || new Date(cur.updated_at) < new Date(r.updated_at)) {
          items[r.key] = { value: r.value, deleted: r.deleted, updated_at: r.updated_at, device: r.device, dirty: false }; changed = true;
        }
        if (!maxS || new Date(r.server_at) > new Date(maxS)) maxS = r.server_at;
      }
      LS.set('lastPull', maxS); LS.set('items', items); LS.set('lastSyncOk', new Date().toISOString());
      if (!LS.get('fk', null)) { try { const k = await rpc('viagem_files_key', { p_trip: c.trip, p_secret: settings.secret }); if (k) LS.set('fk', k); } catch (x) { } }
      lastErr = '';
      if (changed) render();
    } catch (e) { lastErr = e.message || 'Falha'; }
    syncing = false; updateDot();
  }
  function updateDot() {
    const d = $('#sync-dot'); if (!d) return;
    const pend = Object.values(items).some(v => v.dirty);
    d.className = 'dot ' + (!syncConfigured() ? 'off' : lastErr ? 'err' : (pend || syncing) ? 'pending' : 'ok');
  }
  window.addEventListener('online', () => scheduleSync(500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleSync(300); render(); } });
  setInterval(() => scheduleSync(0), 60000);

  /* ---------------- anexos (IndexedDB, só neste celular) ---------------- */
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open('eu26', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  async function fileOp(mode, fn) { const db = await idb; return new Promise((res, rej) => { const tx = db.transaction('files', mode); const st = tx.objectStore('files'); const q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); }
  const filesAll = () => fileOp('readonly', s => s.getAll());
  const filePut = f => fileOp('readwrite', s => s.put(f));
  const fileDel = id => fileOp('readwrite', s => s.delete(id));

  /* ---------------- tempo ---------------- */
  function now() {
    const q = new URLSearchParams(location.search).get('now');
    return q ? new Date(q) : new Date();
  }
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fmtDay = iso => { const [y, m, d] = iso.split('-'); return d + '/' + m; };
  function stopTimes(day) {
    let prev = null; const out = [];
    for (const s of day.stops) {
      let st = null, en = null;
      if (s.at) st = new Date(s.at);
      else {
        const m = [...s.time.matchAll(/(\d{1,2}):(\d{2})/g)];
        if (m.length) {
          st = new Date(day.date + 'T' + m[0][1].padStart(2, '0') + ':' + m[0][2]);
          if (m[1]) { en = new Date(day.date + 'T' + m[1][1].padStart(2, '0') + ':' + m[1][2]); if (en < st) en = new Date(en.getTime() + 864e5); }
        }
      }
      if (!st) st = prev;
      prev = en || st; out.push({ s, st, en });
    }
    return out;
  }

  /* ---------------- UI base ---------------- */
  let tab = LS.get('tab', 'agora'), cityFilter = LS.get('city', null), dicasCity = null;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
  function openSheet(title, html) {
    $('#sheet-title').textContent = title; $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; $('#sheet-body').scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; if (typeof stopSpeak === 'function') stopSpeak(); if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; gpsPos = null; } curGuide = null; }
  $('#sheet-close').onclick = closeSheet;
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => { tab = b.dataset.tab; LS.set('tab', tab); render(); window.scrollTo(0, 0); });
  $('#settings-btn').onclick = renderSettings;
  $('#sync-btn').onclick = () => {
    if (!syncConfigured()) { renderSettings(); return; }
    toast(navigator.onLine ? 'Sincronizando…' : 'Sem internet — os dados ficam guardados e sobem depois');
    sync().then(() => { if (navigator.onLine) toast(lastErr ? '⚠️ ' + lastErr : '✅ Sincronizado'); });
  };

  function modalHtml(id) { const m = T.modals[id]; return m ? m.html : '<p class="muted">Sem detalhes.</p>'; }
  function showModal(id) { const m = T.modals[id]; if (m) openSheet(m.title, m.html); }

  /* ---------------- links de transporte ---------------- */
  const uberLink = dest => 'https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=' + encodeURIComponent(dest);
  const mapsTransit = (dest, origin) => 'https://www.google.com/maps/dir/?api=1' + (origin ? '&origin=' + encodeURIComponent(origin) : '') + '&destination=' + encodeURIComponent(dest) + '&travelmode=transit';
  function hotelOf(city) { return getItem('hotel:' + city) || (T.hotels && T.hotels[city]) || ''; }

  function rideBox(r) {
    const first = r.app === 'bolt'
      ? `<a class="btn ride" href="https://bolt.eu/" target="_blank" rel="noopener" data-copy="${esc(r.dest)}">Bolt</a><a class="btn secondary" href="${uberLink(r.dest)}" target="_blank" rel="noopener">Uber</a>`
      : `<a class="btn ride" href="${uberLink(r.dest)}" target="_blank" rel="noopener">Uber</a><a class="btn secondary" href="https://bolt.eu/" target="_blank" rel="noopener" data-copy="${esc(r.dest)}">Bolt</a>`;
    return `<div class="ridebox"><b>🚕 Aqui vale carro</b><div class="small">${esc(r.why)}</div><div class="small muted" style="margin-top:4px">${esc(r.tip)}</div>
      <div class="small" style="margin-top:6px">Destino: <b style="display:inline">${esc(r.dest)}</b></div>
      <div class="stop-actions">${first}<button class="btn secondary" data-copy="${esc(r.dest)}">Copiar destino</button></div></div>`;
  }

  function stopCard(day, s, opts = {}) {
    const done = !!getItem('done:' + s.id);
    const notes = (s.notes || []).map(n => `<div class="note ${esc(n.k)}">${esc(n.t)}</div>`).join('');
    const links = (s.links || []).map(l => `<a class="btn secondary" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label.replace('Abrir primeiro ponto no Google Maps', '📍 Abrir no Maps').replace('Rota desde o ponto anterior', 'Rota'))}</a>`).join('');
    const title = s.modal && T.modals[s.modal] ? `<span class="link" data-modal="${esc(s.modal)}">${esc(s.title)}</span> ⓘ` : esc(s.title);
    const tk = s.tk && T.tickets.find(x => x.id === s.tk);
    const tst = tk ? (getItem('ticket:' + tk.id) || tk.status) : null;
    const state = tk && tst === 'ok' && tk.status !== 'ok' ? 'COMPRADO' : s.state;
    const pill = state ? `<span class="pill ${/COMPRADO|CONFIRMADO|INCLU|RESERVADO/i.test(state) ? 'ok' : /COMPRAR|RESERVAR/i.test(state) ? 'todo' : 'info'}">${esc(state)}</span>` : '';
    const buy = tk && tst === 'todo' ? `<div class="buybox ${/HOJE|passou|faltam/.test(dueText(tk)) ? 'hot' : ''}"><b>🎟️ ${/local/i.test(tk.label) ? 'Ingresso ainda não comprado — compre no local' : 'FALTA COMPRAR INGRESSO'}</b>
        <div class="small">${esc(dueText(tk))}${tk.label ? ' · ' + esc(tk.label) : ''}</div>${tk.how ? `<div class="small">${esc(tk.how)}</div>` : ''}
        <div class="row wrap" style="margin-top:6px">${tk.url ? `<a class="btn" style="font-size:13px;padding:7px 10px" href="${esc(tk.url)}" target="_blank" rel="noopener">${/local/i.test(tk.label) ? 'Site oficial' : 'Comprar no site oficial'}</a>` : ''}<button class="btn secondary" style="font-size:13px;padding:7px 10px" data-tstatus="${tk.id}">✓ Já comprei</button></div></div>`
      : tk && tst === 'ok' && (tk.files || []).length ? `<div class="attach">${tk.files.map((f, i) => `<button class="btn" style="font-size:13px;padding:7px 10px" data-tfile="${tk.id}" data-tidx="${i}">🎫 ${esc(f.label)}</button>`).join('')}</div>` : '';
    return `<div class="stop ${done ? 'done' : ''} ${s.meal ? 'meal' : ''} ${opts.now ? 'now' : ''}">
      <div class="time">${esc(s.time)}</div><h3>${title} ${pill}</h3>${buy}${s.desc ? `<p>${esc(s.desc)}</p>` : ''}${notes}
      ${s.ride ? rideBox(s.ride) : ''}
      ${s.modal && T.guides && T.guides[s.modal] ? `<button class="btn full guide-btn" data-guide="${esc(s.modal)}">🎧 Guia no local — percurso + ouvir</button>` : ''}
      ${(s.photos || []).length ? `<button class="btn full photo-btn" data-sphotos="${esc(s.photos.join(','))}">📸 Onde tirar a melhor foto${s.photos.length > 1 ? ' (' + s.photos.length + ' pontos)' : ''}</button>` : ''}
      ${(s.lore || []).length ? `<button class="btn full lore-btn" data-lore="${esc(s.lore.join(','))}">📜 História e curiosidades${s.lore.length > 1 ? ' (' + s.lore.length + ')' : ''}: ${esc((loreItem(s.lore[0]) || {}).title || '')}</button>` : ''}
      ${links ? `<div class="stop-actions">${links}</div>` : ''}
      <label class="check"><input type="checkbox" data-done="${esc(s.id)}" ${done ? 'checked' : ''}> feito</label></div>`;
  }

  /* ---------------- MELHORES FOTOS ---------------- */
  function photoItem(ref) { const [cid, id] = ref.split(':'); return ((T.photos || {})[cid] || []).find(x => x.id === id); }
  function photoBlock(x) {
    return `<div class="tipsec"><h3>📸 ${esc(x.title)}</h3><div class="small"><b>Onde:</b> ${esc(x.where)}</div><div class="small"><b>Melhor hora:</b> ${esc(x.when)}</div><div class="small" style="margin-top:4px">💡 ${esc(x.tip)}</div>${x.day ? `<div class="small muted">📅 ${fmtDay(x.day)}</div>` : ''}
      <a class="btn secondary" style="font-size:13px;padding:7px 10px;margin-top:6px" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.q)}">📍 Abrir no mapa</a>${x.ig ? ` <a class="btn secondary" style="font-size:13px;padding:7px 10px;margin-top:6px" target="_blank" rel="noopener" href="https://www.instagram.com/explore/tags/${encodeURIComponent(x.ig)}/">📷 Ver fotos no Instagram #${esc(x.ig)}</a>` : ''}</div>`;
  }
  function openPhotos(cid) {
    stopSpeak();
    const L = (T.photos || {})[cid] || [];
    openSheet('📸 Melhores fotos — ' + CITY[cid].flag + ' ' + CITY[cid].name,
      `<div class="note small">🌆 Em dezembro o sol se põe por volta das 16:00. A <b>hora azul</b> (16:00–16:40) é a melhor para pontes e monumentos acesos; lugares cheios rendem foto limpa só bem cedo.</div>` + L.map(photoBlock).join(''));
  }
  function openStopPhotos(refs) { stopSpeak(); openSheet('📸 Onde tirar a melhor foto', refs.split(',').map(photoItem).filter(Boolean).map(photoBlock).join('')); }
  function photoBtn(cid, cls) { return (T.photos || {})[cid] ? `<button class="btn ${cls || 'secondary'}" data-photos="${cid}">📸 Melhores fotos</button>` : ''; }

  /* ---------------- DICAS DO PAÍS ---------------- */
  function tipsBtn(cid, cls) { const t = T.tips.cities[cid]; return t && t.money ? `<button class="btn ${cls || 'secondary'}" data-ctips="${cid}">💡 Dicas de ${esc(CITY[cid].name)}</button>` : ''; }
  function countryHtml(cid) {
    const t = T.tips.cities[cid], c = CITY[cid], sec = (ic, tt, body) => body ? `<div class="tipsec"><h3>${ic} ${tt}</h3><div class="small">${body}</div></div>` : '';
    const own = t.own && /^SIM/.test(t.own);
    return `<div class="note ${own ? 'warn' : ''}"><b>${esc(t.country || '')}</b> · Moeda: <b>${esc(t.currency || c.currency)}</b><br>Moeda própria? <b>${esc(t.own || '')}</b>${t.cashplan ? `<div style="margin-top:4px">💵 ${esc(t.cashplan)}</div>` : ''}</div>` +
      sec('💰', 'Dinheiro: cartão ou espécie?', t.money + (t.cash ? `<div style="margin-top:6px"><b>Quanto levar em espécie:</b> ${esc(t.cash)}</div>` : '')) +
      sec('🏧', 'Onde sacar barato', t.atm + '<div style="margin-top:6px">Na tela do caixa e na maquininha, escolha sempre a <b>moeda local</b> (“without conversion”), nunca reais.</div>') +
      sec('📅', 'Dias em que fecha', t.closed) +
      sec('🚨', 'Golpes e batedores de carteira', esc(t.scams)) +
      sec('🍽️', 'Gorjeta', esc(t.tipping)) +
      sec('🚻', 'Banheiro', esc(t.toilets)) +
      sec('💧', 'Água', t.water) +
      sec('🚕', 'Uber / Bolt', esc(t.rides)) +
      sec('🔌', 'Tomada', esc(t.plug)) +
      sec('⭐', 'Bom saber', esc(t.extra)) +
      `<div class="tipsec"><h3>🗣️ Frases úteis</h3>${t.phrases.map(p => `<div class="phrase"><span>${esc(p[0])}</span><b>${esc(p[1])}</b></div>`).join('')}</div>` +
      `<div class="tipsec"><h3>🆘 Emergência</h3><div class="big" style="font-size:22px">${esc(t.emergency)}</div></div>` +
      (t.souvenirs ? `<div class="tipsec"><h3>🎁 Lembranças para comprar</h3><div class="small">${t.souvenirs.map(x => esc(x.item)).join(' · ')}</div></div>` : '') +
      `<div class="row wrap" style="margin-top:10px">${souvBtn(cid)}<button class="btn secondary" data-modal="${c.transport}">🚇 Transporte e bilhetes</button>${histBtn(cid)}</div>`;
  }
  function souvHtml(cid) {
    const t = T.tips.cities[cid];
    return `<p class="small muted">Lembranças típicas para a estante — escolha as que mais gostar.</p>` +
      t.souvenirs.map(x => `<div class="tipsec souv">${x.svg ? `<div class="souvimg">${x.svg}</div>` : ''}<div><h3>${esc(x.item)}</h3><div class="small">${esc(x.tip)}</div></div></div>`).join('') +
      (t.shops ? `<h3 style="margin-top:14px">📍 Onde comprar — do mais barato ao mais caro</h3><p class="small muted">Estimativa: a mesma miniatura costuma custar menos nas ruas de lojas e mercados do que nas lojas oficiais, de museu e de aeroporto.</p>` + t.shops.map(x => `<div class="tipsec"><h3>${esc(x.name)} <span class="pill ${/mais barato/.test(x.price) ? 'ok' : /caro/.test(x.price) ? 'todo' : 'info'}">${esc(x.price || '')}</span></h3><div class="small">${esc(x.what)}</div><div class="small muted">📅 ${esc(x.day)}</div>
        <a class="btn secondary" style="font-size:13px;padding:7px 10px;margin-top:6px" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.q)}">📍 Abrir no mapa</a></div>`).join('') : '') +
      `<div class="note small">🛍️ Compre em lojas e mercados de Natal, nunca de vendedor de rua. Peça para embrulhar bem o que for frágil. Globo de neve com mais de 100 ml vai na mala despachada.</div>`;
  }
  function openSouv(cid) { stopSpeak(); openSheet('🎁 Lembranças — ' + CITY[cid].flag + ' ' + CITY[cid].name, souvHtml(cid)); }
  function souvBtn(cid, cls) { const t = T.tips.cities[cid]; return t && t.souvenirs ? `<button class="btn ${cls || 'secondary'}" data-souv="${cid}">🎁 Lembranças</button>` : ''; }
  function openCountry(cid) { stopSpeak(); openSheet('💡 Dicas — ' + CITY[cid].flag + ' ' + CITY[cid].name, countryHtml(cid)); }

  /* ---------------- HISTÓRIA DAS CIDADES E DOS LUGARES ---------------- */
  let hsay = {};
  function loreItem(ref) { const [cid, id] = ref.split(':'); const c = T.history && T.history[cid]; if (!c) return null; return [...c.legends, ...c.places].find(x => x.id === id) || null; }
  function histBtn(cid, cls) { const c = T.history && T.history[cid]; return c ? `<button class="btn ${cls || 'secondary'}" data-hist="${cid}">📜 História de ${esc(CITY[cid].name)}</button>` : ''; }
  function storyBlock(key, title, text) {
    hsay[key] = title.replace(/^[^\wÀ-ú]+/, '') + '. ' + text;
    return `<div class="story"><h3>${esc(title)}</h3><p>${esc(text)}</p><button class="btn secondary" style="font-size:13px;padding:7px 10px" data-hsay="${key}" data-label="▶ Ouvir">▶ Ouvir</button></div>`;
  }
  function openHistory(cid) {
    const c = T.history[cid]; stopSpeak(); hsay = {};
    hsay.intro = c.intro;
    const dayOf = L => L.stop ? fmtDay(L.stop[0]) : '';
    let h = `<p>${esc(c.intro)}</p><button class="btn" data-hsay="intro" data-label="▶ Ouvir a história">▶ Ouvir a história</button>
      <h3 style="margin-top:16px">🕰️ Linha do tempo</h3><div class="tl">${c.timeline.map(t => `<div class="tl-row"><b>${esc(t[0])}</b><span>${esc(t[1])}</span></div>`).join('')}</div>
      <h3 style="margin-top:16px">🐉 Lendas e histórias</h3>${c.legends.map(L => storyBlock(cid + ':' + L.id, L.title + (L.stop ? ' · ' + dayOf(L) : ''), L.text)).join('')}`;
    if (c.places.length) h += `<h3 style="margin-top:16px">📍 Os lugares do seu roteiro</h3>${c.places.map(L => storyBlock(cid + ':' + L.id, L.title + ' · ' + dayOf(L), L.text)).join('')}`;
    h += `<h3 style="margin-top:16px">💡 Curiosidades</h3><ul class="small">${c.curiosities.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    openSheet(c.icon + ' ' + c.title, h);
  }
  function openLore(refs) {
    stopSpeak(); hsay = {};
    const items = refs.split(',').map(r => [r, loreItem(r)]).filter(x => x[1]);
    const cid = refs.split(':')[0];
    let h = items.map(([r, L]) => storyBlock(r, L.title, L.text)).join('') + `<div style="margin-top:12px">${histBtn(cid, 'full')}</div>`;
    openSheet('📜 História e curiosidades', h);
  }

  /* ---------------- GUIA NO LOCAL (voz + GPS) ---------------- */
  let gpsWatch = null, gpsPos = null, curGuide = null;
  const synth = window.speechSynthesis;
  function ptVoice() { const vs = synth ? synth.getVoices() : []; return vs.find(v => v.lang === 'pt-BR') || vs.find(v => /^pt/.test(v.lang)) || null; }
  let speakQueue = [], speakingKey = null;
  function sayBtn(k) { return document.querySelector('[data-say="' + k + '"]') || document.querySelector('[data-hsay="' + k + '"]'); }
  function setSayLabel(k, on) { const b = k != null && sayBtn(k); if (b) b.textContent = on ? '⏹ Parar' : b.dataset.label; }
  function stopSpeak() { if (synth) synth.cancel(); speakQueue = []; setSayLabel(speakingKey, false); speakingKey = null; }
  function speakChunks(text, key) {
    stopSpeak(); if (!synth) { toast('Este celular não tem leitura em voz'); return; }
    speakQueue = text.match(/[^.!?]+[.!?]*/g) || [text];
    speakingKey = key; setSayLabel(key, true);
    const next = () => {
      if (!speakQueue.length) { setSayLabel(speakingKey, false); speakingKey = null; return; }
      const u = new SpeechSynthesisUtterance(speakQueue.shift().trim());
      u.lang = 'pt-BR'; const v = ptVoice(); if (v) u.voice = v; u.rate = 1.0;
      u.onend = next; u.onerror = next; synth.speak(u);
    };
    next();
  }
  function stopText(st) { return st.title + '. ' + st.where + '. ' + st.text + ' O que olhar: ' + st.look.join('; ') + '. Dica de foto: ' + st.photo; }
  function dist(a, b) { const R = 6371e3, r = x => x * Math.PI / 180; const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  function guideHtml(id) {
    const g = T.guides[id], hasGps = g.stops.some(x => x.lat);
    const seen = i => !!getItem('guide:' + id + ':' + i);
    const nSeen = g.stops.filter((_, i) => seen(i)).length;
    let near = -1;
    if (gpsPos && hasGps) { let best = 1e9; g.stops.forEach((st, i) => { if (st.lat) { const d = dist(gpsPos, st); if (d < best) { best = d; near = i; } } }); }
    let h = `<div class="guide-top"><div class="small muted">⏱ ${esc(g.duration)} • <span class="progress">${nSeen}/${g.stops.length} vistas</span></div>
      <div class="note">${esc(g.ticket)}</div>${g.warn ? `<div class="note warn">⚠️ ${esc(g.warn)}</div>` : ''}
      <div class="row wrap" style="margin-top:10px"><button class="btn" data-say="intro" data-label="▶ Ouvir introdução">▶ Ouvir introdução</button>
      ${hasGps ? `<button class="btn secondary" data-gps="1">${gpsWatch != null ? '📍 GPS ligado' : '📍 Onde estou'}</button>` : ''}</div>
      <p style="margin-top:10px">${esc(g.intro)}</p>
      <div class="note pub"><b>Com pressa?</b> Não perca: ${g.quick.map(n => `<b>${n}. ${esc(g.stops[n - 1].title)}</b>`).join(' • ')}</div></div>`;
    g.stops.forEach((st, i) => {
      const d = gpsPos && st.lat ? dist(gpsPos, st) : null;
      h += `<div class="gstop ${seen(i) ? 'seen' : ''} ${i === near ? 'near' : ''} ${g.quick.includes(i + 1) ? 'gmust' : ''}" id="gs-${i}">
        <div class="gnum">${i + 1}</div><div class="grow">
        <h3>${esc(st.title)}</h3><div class="small muted">📍 ${esc(st.where)} • ⏱ ${esc(st.time)}${d != null ? ` • <b>${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'}</b>` : ''}${i === near ? ' • <b style="color:var(--green)">você está aqui perto</b>' : ''}</div>
        <p>${esc(st.text)}</p>
        <div class="small"><b>👀 O que olhar</b><ul>${st.look.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
        <div class="note small">📸 ${esc(st.photo)}</div>
        <div class="stop-actions"><button class="btn" data-say="${i}" data-label="▶ Ouvir">▶ Ouvir</button>
        ${st.lat ? `<a class="btn secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=walking">🧭 Ir até aqui</a>` : ''}</div>
        <label class="check"><input type="checkbox" data-gseen="${i}" ${seen(i) ? 'checked' : ''}> já vi</label></div></div>`;
    });
    return h;
  }
  function openGuide(id) {
    curGuide = id; stopSpeak();
    openSheet(T.guides[id].title, guideHtml(id));
  }
  function refreshGuide() { if (!curGuide || $('#sheet').hidden) return; const b = $('#sheet-body'), y = b.scrollTop; b.innerHTML = guideHtml(curGuide); b.scrollTop = y; setSayLabel(speakingKey, true); }
  function toggleGps() {
    if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; gpsPos = null; refreshGuide(); return; }
    if (!navigator.geolocation) { toast('GPS indisponível'); return; }
    gpsWatch = navigator.geolocation.watchPosition(p => { gpsPos = { lat: p.coords.latitude, lng: p.coords.longitude }; refreshGuide(); },
      () => { toast('Permita a localização para o app em Ajustes do iPhone'); gpsWatch = null; }, { enableHighAccuracy: true, maximumAge: 15000 });
    toast('GPS ligado — funciona sem internet');
  }

  /* ---------------- PENDÊNCIAS DE INGRESSOS ---------------- */
  function pendingTickets() {
    return T.tickets.filter(t => (getItem('ticket:' + t.id) || t.status) === 'todo')
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  }
  function dueText(t) {
    if (!t.due) return '';
    const d = Math.round((new Date(t.due + 'T23:59') - now()) / 864e5);
    const when = fmtDay(t.due);
    return d < 0 ? `⚠️ prazo passou (${when})` : d === 0 ? '⏰ comprar HOJE' : d <= 7 ? `⏰ comprar até ${when} (faltam ${d} dia${d > 1 ? 's' : ''})` : `comprar até ${when}`;
  }
  function pendingCard(max) {
    const p = pendingTickets(); if (!p.length) return '';
    const urgent = p.filter(t => t.due && (new Date(t.due + 'T23:59') - now()) / 864e5 <= 7).length;
    return `<div class="card" style="border-left:5px solid ${urgent ? 'var(--red)' : 'var(--gold)'}"><h3>🎟️ Ingressos para comprar (${p.length})</h3>` +
      p.slice(0, max || 99).map(t => `<div class="list-item"><div class="grow"><b>${esc(t.name.split('—').slice(1).join('—').trim())}</b>
        <div class="small" style="color:${/HOJE|passou|faltam/.test(dueText(t)) ? 'var(--red)' : 'var(--muted)'}">${esc(dueText(t))}</div>
        ${t.how ? `<div class="small">${esc(t.how)}</div>` : ''}${t.url ? `<a class="small" href="${esc(t.url)}" target="_blank" rel="noopener">Abrir site oficial →</a>` : ''}</div></div>`).join('') +
      `<button class="btn secondary full" style="margin-top:8px" data-goto="ingressos">Ver todos os ingressos</button></div>`;
  }

  /* ---------------- AGORA ---------------- */
  function renderAgora() {
    const n = now(), today = ymd(n);
    const first = T.days[0], last = T.days[T.days.length - 1];
    let h = '';
    if (today < first.date) {
      const dd = Math.ceil((new Date(first.date + 'T00:00') - new Date(today + 'T00:00')) / 864e5);
      const ck = T.tips.checklist, okc = ck.filter(c => getItem('check:' + c.id)).length;
      h += `<div class="card"><div class="kicker">Contagem regressiva</div><div class="big">${dd} dia${dd > 1 ? 's' : ''}</div><div class="muted">para 19/12 — chegada em Londres</div></div>`;
      h += pendingCard(6);
      h += `<div class="card"><h2>Antes de viajar</h2><div class="progress">${okc} de ${ck.length} feitos</div>` +
        ck.map(c => `<label class="check" style="color:var(--ink)"><input type="checkbox" data-check="${c.id}" ${getItem('check:' + c.id) ? 'checked' : ''}> ${esc(c.t)}</label>`).join('') + '</div>';
      h += `<div class="card"><h3>Primeiro dia</h3>${stopCard(first, first.stops[0])}</div>`;
    } else if (today > last.date) {
      h += `<div class="card"><div class="kicker">Viagem concluída</div><h2>Bem-vindos de volta! 🇧🇷</h2><p>Veja o total na aba Gastos.</p></div>`;
    } else {
      let day = T.days.find(d => d.date === today);
      // madrugada após um dia que avança para depois da meia-noite
      const timed = T.days.flatMap(d => stopTimes(d).map(x => Object.assign({ day: d }, x)));
      const past = timed.filter(x => x.st && x.st <= n);
      let cur = null;
      if (past.length) {
        const maxSt = past[past.length - 1].st.getTime();
        const grp = past.filter(x => x.st.getTime() === maxSt);
        cur = grp.find(x => !getItem('done:' + x.s.id)) || grp[grp.length - 1];
      }
      const next = timed.find(x => x.st && x.st > n);
      const showCur = cur && !(cur.en && n - cur.en > 30 * 60000 && next);
      day = showCur ? cur.day : next ? next.day : (day || (cur && cur.day));
      const city = day ? CITY[day.city] : null;
      $('#hdr-sub').textContent = day ? `${city.flag} ${city.name} • ${day.title.split('—')[1] || ''}` : '';
      if (showCur) {
        h += `<div class="kicker" style="margin:4px 2px">Agora</div>${stopCard(cur.day, cur.s, { now: true })}`;
      }
      if (next) {
        const mins = Math.round((next.st - n) / 60000);
        const when = mins < 60 ? `em ${mins} min` : mins < 1440 ? `em ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : fmtDay(next.day.date);
        h += `<div class="kicker" style="margin:14px 2px 4px">Próximo • ${when}</div>${stopCard(next.day, next.s)}`;
      }
      if (pendingTickets().some(t => t.due && (new Date(t.due + 'T23:59') - n) / 864e5 <= 3)) h += pendingCard(3);
      if (city) {
        const hotel = hotelOf(city.id);
        h += `<div class="card" style="margin-top:14px"><div class="row wrap">
          <button class="btn secondary" data-modal="${city.transport}">🚇 Transporte em ${esc(city.name)}</button>
          ${hotel ? `<a class="btn secondary" href="${mapsTransit(hotel)}" target="_blank" rel="noopener">🏨 Voltar ao hotel</a>` : `<button class="btn secondary" data-goto="settings">🏨 Cadastrar hotel</button>`}
          <button class="btn secondary" data-goto="roteiro" data-day="${day.date}">📅 Dia completo</button>${tipsBtn(city.id)}${souvBtn(city.id)}${photoBtn(city.id)}${histBtn(city.id)}</div></div>`;
      }
    }
    return h;
  }

  /* ---------------- ROTEIRO ---------------- */
  function renderRoteiro() {
    const today = ymd(now());
    let h = `<div class="chips"><button class="chip ${!cityFilter ? 'active' : ''}" data-city="">Todas</button>` +
      T.cities.map(c => `<button class="chip ${cityFilter === c.id ? 'active' : ''}" data-city="${c.id}">${c.flag} ${esc(c.name)}</button>`).join('') + '</div>';
    if (cityFilter) {
      const c = CITY[cityFilter], hotel = hotelOf(c.id);
      h += `<div class="row wrap" style="margin-bottom:10px"><button class="btn secondary" data-modal="${c.transport}">🚇 Como se locomover + bilhetes</button>
        ${hotel ? `<a class="btn secondary" href="${mapsTransit(hotel)}" target="_blank" rel="noopener">🏨 Hotel</a>` : ''}${tipsBtn(c.id)}${souvBtn(c.id)}${photoBtn(c.id)}${histBtn(c.id)}</div>`;
    }
    let prevCity = null;
    for (const d of T.days.filter(d => !cityFilter || d.city === cityFilter)) {
      const doneN = d.stops.filter(s => getItem('done:' + s.id)).length;
      const buyN = d.stops.filter(s => { const t = s.tk && T.tickets.find(x => x.id === s.tk); return t && (getItem('ticket:' + t.id) || t.status) === 'todo'; }).length;
      h += `<div class="card day ${d.date === today ? 'today' : ''}" id="day-${d.date}"><div class="day-head"><div><h2>${esc(d.title)}</h2><div class="muted small">${CITY[d.city].flag} ${esc(d.sub)} • ${doneN}/${d.stops.length}${buyN ? ` • <b style="color:var(--red)">🎟️ ${buyN} ingresso${buyN > 1 ? 's' : ''} a comprar</b>` : ''}</div></div>${d.badge ? `<span class="badge">${esc(d.badge)}</span>` : ''}</div>` +
        (d.city !== prevCity ? `<div class="citybtns"><button class="btn tips-btn" data-ctips="${d.city}">💡 Dicas de ${esc(CITY[d.city].name)}<small>dinheiro, saques, golpes, gorjeta</small></button>${T.history && T.history[d.city] ? `<button class="btn hist-btn" data-hist="${d.city}">📜 História<small>ler ou ouvir</small></button>` : ''}${T.tips.cities[d.city] && T.tips.cities[d.city].souvenirs ? `<button class="btn souv-btn" data-souv="${d.city}">🎁 Lembranças<small>o que comprar</small></button>` : ''}${(T.photos || {})[d.city] ? `<button class="btn photo-btn" data-photos="${d.city}">📸 Fotos<small>melhores pontos</small></button>` : ''}</div>` : '') +
        d.stops.map(s => stopCard(d, s)).join('') + '</div>';
      prevCity = d.city;
    }
    return h;
  }

  /* ---------------- ARQUIVOS DE INGRESSO (criptografados) ---------------- */
  let cryptoKey = null;
  async function getKey() {
    if (cryptoKey) return cryptoKey;
    let k = LS.get('fk', null);
    if (!k && navigator.onLine && syncConfigured()) {
      try { const c = cfg(); k = await rpc('viagem_files_key', { p_trip: c.trip, p_secret: settings.secret }); if (k) LS.set('fk', k); } catch (x) { }
    }
    if (!k) return null;
    const raw = Uint8Array.from(atob(k), ch => ch.charCodeAt(0));
    cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    return cryptoKey;
  }
  async function openTicketFile(tid, idx) {
    const t = T.tickets.find(x => x.id === tid), f = t.files[idx];
    openSheet('🎫 ' + (t.name.split('—').slice(1).join('—').trim() || t.name), '<div class="empty">Abrindo ingresso…</div>');
    const key = await getKey();
    if (!key) { $('#sheet-body').innerHTML = '<div class="note warn">Para abrir os ingressos pela primeira vez, conecte à internet e confira a <b>senha da viagem</b> em ⚙️. Depois disso eles abrem sem internet.</div>'; return; }
    try {
      const imgs = [];
      for (const pg of f.pages) {
        const buf = new Uint8Array(await (await fetch(pg)).arrayBuffer());
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
        imgs.push(URL.createObjectURL(new Blob([plain], { type: 'image/png' })));
      }
      $('#sheet-body').innerHTML = `<div class="note small">💡 Aumente o brilho da tela ao mostrar o código. Dá para ampliar com dois dedos.</div>` +
        imgs.map(u => `<img src="${u}" style="width:100%;background:#fff;border:1px solid #ddd;border-radius:8px;margin-top:10px">`).join('');
    } catch (e) { $('#sheet-body').innerHTML = '<div class="note warn">Não consegui abrir este ingresso neste celular. Abra o app com internet uma vez e tente de novo.</div>'; }
  }

  /* ---------------- INGRESSOS ---------------- */
  let filesCache = [];
  function renderIngressos() {
    const groups = {};
    T.tickets.forEach(t => (groups[t.city] = groups[t.city] || []).push(t));
    const todo = T.tickets.filter(t => (getItem('ticket:' + t.id) || t.status) === 'todo').length;
    let h = `<div class="card"><h2>🎟️ Ingressos e reservas</h2><div class="muted small">Toque no status para mudar. Anexe PDF/print do QR code: o arquivo fica salvo <b>neste celular</b> e abre sem internet (cada um anexa no seu).</div>${todo ? `<div class="note warn">${todo} pendente${todo > 1 ? 's' : ''} para comprar/reservar</div>` : ''}</div>`;
    for (const [city, list] of Object.entries(groups)) {
      h += `<div class="card"><h3>${esc(city)}</h3>` + list.map(t => {
        const st = getItem('ticket:' + t.id) || t.status;
        const lbl = st === 'ok' ? (t.status === 'ok' ? t.label : 'Comprado') : st === 'todo' ? (t.status === 'todo' ? t.label : 'Pendente') : t.label;
        const fs = filesCache.filter(f => f.ticket === t.id);
        return `<div class="list-item"><div class="grow"><div>${esc(t.name.split('—').slice(1).join('—').trim() || t.name)}</div>
          <button class="pill ${st}" style="border:0;margin:4px 0 0" data-tstatus="${t.id}">${esc(lbl)}</button>
          ${st === 'todo' && t.due ? `<div class="small" style="color:var(--red)">${esc(dueText(t))}</div>` : ''}${st === 'todo' && t.how ? `<div class="small muted">${esc(t.how)}</div>` : ''}${st === 'todo' && t.url ? `<a class="small" href="${esc(t.url)}" target="_blank" rel="noopener">Site oficial →</a>` : ''}
          ${(t.files || []).length ? `<div class="attach">${t.files.map((f, i) => `<button class="btn" style="font-size:13px;padding:7px 10px" data-tfile="${t.id}" data-tidx="${i}">🎫 ${esc(f.label)}</button>`).join('')}</div>` : ''}
          <div class="attach">${fs.map(f => `<button class="btn secondary" data-file="${f.id}">📄 ${esc(f.name.slice(0, 22))}</button>`).join('')}
          <label class="btn secondary">＋ Anexar<input type="file" accept="application/pdf,image/*" data-attach="${t.id}" hidden></label></div></div></div>`;
      }).join('') + '</div>';
    }
    return h;
  }

  /* ---------------- GASTOS ---------------- */
  const CATS = ['🍽️ Comida', '🚇 Transporte', '🎟️ Ingressos', '🛍️ Compras', '🏨 Hospedagem', '☕ Lanche', '📦 Outros'];
  function rates() { return getItem('rates') || null; } // {base:'BRL', r:{EUR:x...}, date}
  function toBRL(v, cur) { const r = rates(); if (cur === 'BRL') return v; if (!r || !r.r[cur]) return null; return v / r.r[cur]; }
  const money = (v, cur) => (cur === 'BRL' ? 'R$ ' : '') + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: cur === 'HUF' ? 0 : 2, maximumFractionDigits: cur === 'HUF' ? 0 : 2 }) + (cur === 'BRL' ? '' : ' ' + cur);
  function currentCurrency() {
    const t = ymd(now()); const d = T.days.find(x => x.date === t) || T.days[0]; return CITY[d.city].currency;
  }
  async function updateRates() {
    if (!navigator.onLine) { toast('Sem internet para atualizar a cotação'); return; }
    try {
      let j = null;
      for (const u of ['https://api.frankfurter.dev/v1/latest?base=BRL&symbols=EUR,GBP,CZK,PLN,HUF', 'https://api.frankfurter.app/latest?from=BRL&to=EUR,GBP,CZK,PLN,HUF']) {
        try { const r = await fetch(u); if (r.ok) { j = await r.json(); if (j && j.rates) break; } } catch (x) { }
      }
      if (!j || !j.rates) throw new Error('x');
      setItem('rates', { base: 'BRL', r: j.rates, date: j.date }); toast('Cotação atualizada (' + j.date + ')'); render();
    } catch (e) { toast('Não consegui atualizar — use “Digitar cotação”'); }
  }
  function renderGastos() {
    const exps = prefix('exp:').map(([k, v]) => Object.assign({ key: k }, v)).sort((a, b) => b.ts.localeCompare(a.ts));
    const r = rates();
    let total = 0, missing = false; const byCat = {}, byWho = {}, byCur = {};
    exps.forEach(e => {
      const b = toBRL(e.v, e.cur); byCur[e.cur] = (byCur[e.cur] || 0) + e.v;
      if (b == null) { missing = true; return; }
      total += b; byCat[e.cat] = (byCat[e.cat] || 0) + b; byWho[e.who || '?'] = (byWho[e.who || '?'] || 0) + b;
    });
    const eurR = r && r.r.EUR;
    let h = `<div class="card"><div class="kicker">Total da viagem</div><div class="big">${money(total, 'BRL')}</div>
      ${eurR ? `<div class="muted">≈ ${money(total * eurR, 'EUR')}</div>` : ''}
      ${missing ? `<div class="note warn">Há gastos em moeda sem cotação salva — atualize a cotação.</div>` : ''}
      <div class="small muted" style="margin-top:6px">Cotação: ${r ? 'de ' + esc(r.date) : 'ainda não baixada'} <button class="btn secondary" style="padding:5px 9px;font-size:13px" data-act="rates">Atualizar</button> <button class="btn secondary" style="padding:5px 9px;font-size:13px" data-act="manualrate">Digitar cotação</button></div></div>`;
    const cur = currentCurrency();
    h += `<div class="card"><h3>Novo gasto</h3>
      <div class="two"><label class="field"><span>Valor</span><input type="number" inputmode="decimal" step="0.01" id="e-v" placeholder="0,00"></label>
      <label class="field"><span>Moeda</span><select id="e-cur">${CURRENCIES.map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
      <label class="field"><span>Categoria</span><select id="e-cat">${CATS.map(c => `<option>${c}</option>`).join('')}</select></label>
      <label class="field"><span>Descrição (opcional)</span><input type="text" id="e-d" placeholder="Ex.: svařák no mercado"></label>
      <button class="btn full" data-act="addexp">Adicionar gasto</button>
      <div class="small muted" style="margin-top:6px">Lançado por: <b>${esc(settings.device || 'defina seu nome em ⚙️')}</b></div></div>`;
    h += `<div class="card"><h3>Conversor rápido</h3><div class="two"><input type="number" inputmode="decimal" id="c-v" placeholder="Valor"><select id="c-cur">${CURRENCIES.filter(c => c !== 'BRL').map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div><div id="c-out" class="big" style="font-size:22px;margin-top:8px">—</div></div>`;
    if (total) {
      const mx = Math.max(...Object.values(byCat));
      h += `<div class="card"><h3>Por categoria</h3>` + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div style="margin:8px 0"><div class="total"><span>${esc(c)}</span><b>${money(v, 'BRL')}</b></div><div class="bar"><i style="width:${(v / mx * 100).toFixed(0)}%"></i></div></div>`).join('') +
        `<h3 style="margin-top:14px">Por pessoa</h3>` + Object.entries(byWho).map(([w, v]) => `<div class="total" style="margin:6px 0"><span>${esc(w)}</span><b>${money(v, 'BRL')}</b></div>`).join('') +
        `<h3 style="margin-top:14px">Por moeda</h3>` + Object.entries(byCur).map(([c, v]) => `<div class="total" style="margin:6px 0"><span>${c}</span><b>${money(v, c)}</b></div>`).join('') + '</div>';
    }
    h += `<div class="card"><h3>Lançamentos (${exps.length})</h3>` + (exps.length ? exps.map(e => `<div class="list-item"><div class="grow"><b>${money(e.v, e.cur)}</b> <span class="muted small">${esc(e.cat)}</span><div class="small">${esc(e.d || '')}</div><div class="small muted">${new Date(e.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} • ${esc(e.who || '')}${e.cur !== 'BRL' && toBRL(e.v, e.cur) != null ? ' • ' + money(toBRL(e.v, e.cur), 'BRL') : ''}</div></div><button class="btn danger" style="padding:6px 10px" data-delexp="${esc(e.key)}">✕</button></div>`).join('') : '<div class="empty">Nenhum gasto ainda.</div>') + '</div>';
    return h;
  }

  /* ---------------- DICAS ---------------- */
  function renderDicas() {
    const tp = T.tips;
    let h = `<div class="chips"><button class="chip ${!dicasCity ? 'active' : ''}" data-dcity="">Geral</button>` +
      T.cities.map(c => `<button class="chip ${dicasCity === c.id ? 'active' : ''}" data-dcity="${c.id}">${c.flag} ${esc(c.name)}</button>`).join('') + '</div>';
    if (!dicasCity) {
      tp.general.forEach(g => h += `<div class="card"><h3>${esc(g.title)}</h3><div class="small">${g.body}</div></div>`);
      const ck = tp.checklist, okc = ck.filter(c => getItem('check:' + c.id)).length;
      h += `<div class="card"><h3>✅ Antes de viajar <span class="progress small">${okc}/${ck.length}</span></h3>` + ck.map(c => `<label class="check" style="color:var(--ink)"><input type="checkbox" data-check="${c.id}" ${getItem('check:' + c.id) ? 'checked' : ''}> ${esc(c.t)}</label>`).join('') + '</div>';
      h += `<div class="card"><h3>🛠️ Correções desta versão</h3><ul class="small">${T.fixes.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
    } else {
      const c = CITY[dicasCity];
      h += `<div class="card">${countryHtml(c.id)}</div>`;
    }
    return h;
  }

  /* ---------------- AJUSTES ---------------- */
  function renderSettings() {
    const c = cfg();
    const last = LS.get('lastSyncOk', null);
    const h = `<label class="field"><span>Seu nome (aparece nos gastos)</span><input type="text" id="s-dev" value="${esc(settings.device)}" placeholder="Ex.: Luiz"></label>
      <label class="field"><span>Senha da viagem (a mesma nos dois iPhones)</span><input type="password" id="s-sec" value="${esc(settings.secret)}"></label>
      <label class="field"><span>App de mapas</span><select id="s-maps"><option value="google" ${(settings.maps || 'google') === 'google' ? 'selected' : ''}>Google Maps (recomendado p/ metrô e ônibus)</option><option value="apple" ${settings.maps === 'apple' ? 'selected' : ''}>Apple Mapas</option></select></label>
      <h3 style="margin-top:16px">🏨 Hotéis (nome ou endereço)</h3>
      ${T.cities.map(ct => `<label class="field"><span>${ct.flag} ${esc(ct.name)}</span><input type="text" data-hotel="${ct.id}" value="${esc(hotelOf(ct.id))}" placeholder="Nome do hotel + cidade"></label>`).join('')}
      <details style="margin-top:12px"><summary class="small muted">Conexão (avançado)</summary>
      <label class="field"><span>Supabase URL</span><input type="url" id="s-url" value="${esc(settings.url)}" placeholder="${esc(CFG.supabaseUrl || '')}"></label>
      <label class="field"><span>Supabase anon key</span><input type="text" id="s-key" value="${esc(settings.key)}" placeholder="(usa a do config)"></label>
      <label class="field"><span>ID da viagem</span><input type="text" id="s-trip" value="${esc(settings.trip)}" placeholder="${esc(c.trip)}"></label></details>
      <button class="btn full" id="s-save" style="margin-top:12px">Salvar</button>
      <div class="note" style="margin-top:12px">Sincronização: <b>${syncConfigured() ? (lastErr ? '⚠️ ' + esc(lastErr) : 'ativa') : 'não configurada'}</b><br>Último sync: ${last ? new Date(last).toLocaleString('pt-BR') : '—'}<br>Pendentes neste celular: ${Object.values(items).filter(v => v.dirty).length}</div>
      <p class="small muted">Versão do app: v${T.version}. Funciona 100% offline; quando houver internet, envia e recebe as mudanças do outro celular.</p>`;
    openSheet('⚙️ Ajustes', h);
    $('#s-save').onclick = () => {
      settings.device = $('#s-dev').value.trim(); settings.secret = $('#s-sec').value; settings.maps = $('#s-maps').value;
      settings.url = $('#s-url').value.trim(); settings.key = $('#s-key').value.trim(); settings.trip = $('#s-trip').value.trim();
      LS.set('settings', settings);
      document.querySelectorAll('[data-hotel]').forEach(i => { const v = i.value.trim(); if (v !== hotelOf(i.dataset.hotel)) setItem('hotel:' + i.dataset.hotel, v, !v); });
      closeSheet(); render(); lastErr = ''; sync().then(() => toast(lastErr ? '⚠️ ' + lastErr : syncConfigured() ? '✅ Salvo e sincronizado' : 'Salvo'));
    };
  }

  /* ---------------- render + eventos ---------------- */
  async function render() {
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#hdr-sub').textContent = '19/12/2026 → 06/01/2027';
    if (tab === 'ingressos') { try { filesCache = await filesAll(); } catch (e) { filesCache = []; } }
    const v = $('#view');
    v.innerHTML = tab === 'agora' ? renderAgora() : tab === 'roteiro' ? renderRoteiro() : tab === 'ingressos' ? renderIngressos() : tab === 'gastos' ? renderGastos() : renderDicas();
    if (tab === 'roteiro') { const t = document.getElementById('day-' + (render.jump || ymd(now()))); if (t && render.jump !== false) t.scrollIntoView(); render.jump = false; }
    if (tab === 'gastos') bindConverter();
    updateDot();
  }
  function bindConverter() {
    const f = () => { const v = parseFloat($('#c-v').value), cur = $('#c-cur').value, b = toBRL(v, cur); $('#c-out').textContent = isNaN(v) ? '—' : b == null ? 'Atualize a cotação' : money(b, 'BRL'); };
    $('#c-v').oninput = f; $('#c-cur').onchange = f;
  }

  // Abre no aplicativo do iPhone quando existir (mapas, Uber, Bolt, Instagram); se o app não abrir, cai no site
  function mapAppUrl(u) {
    if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname) || !u.pathname.startsWith('/maps')) return null;
    // sem internet: Apple Mapas (tem rota a pé e de metrô offline com mapa baixado); Google Maps offline só faz rota de carro
    const q = u.searchParams, app = !navigator.onLine ? 'apple' : (settings.maps || 'google');
    const dest = q.get('destination'), orig = q.get('origin'), query = q.get('query');
    const mode = q.get('travelmode') || 'transit';
    if (app === 'apple') {
      const flg = { transit: 'r', walking: 'w', driving: 'd' }[mode] || 'r';
      if (dest) return 'maps://?' + (orig ? 'saddr=' + encodeURIComponent(orig) + '&' : '') + 'daddr=' + encodeURIComponent(dest) + '&dirflg=' + flg;
      if (query) return 'maps://?q=' + encodeURIComponent(query);
      return null;
    }
    if (dest) return 'comgooglemaps://?' + (orig ? 'saddr=' + encodeURIComponent(orig) + '&' : '') + 'daddr=' + encodeURIComponent(dest) + '&directionsmode=' + mode;
    if (query) return 'comgooglemaps://?q=' + encodeURIComponent(query);
    return null;
  }
  function appUrl(href) {
    let u; try { u = new URL(href); } catch (x) { return null; }
    const m = mapAppUrl(u); if (m) return m;
    if (u.hostname === 'm.uber.com') return 'uber://' + u.search;
    if (/(^|\.)bolt\.eu$/.test(u.hostname)) return 'bolt://';
    if (/(^|\.)instagram\.com$/.test(u.hostname)) {
      const t = u.pathname.match(/\/explore\/tags\/([^/]+)/); if (t) return 'instagram://tag?name=' + t[1];
      const us = u.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/); if (us) return 'instagram://user?username=' + us[1];
      return 'instagram://app';
    }
    return null;
  }

  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a || !/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
    const app = appUrl(a.href); if (!app) return;
    e.preventDefault();
    if (a.dataset.copy && navigator.clipboard) { navigator.clipboard.writeText(a.dataset.copy).catch(() => { }); toast('📋 Destino copiado — cole no app'); }
    const web = a.href; let left = false;
    const onHide = () => { left = true; };
    document.addEventListener('visibilitychange', onHide, { once: true });
    window.addEventListener('blur', onHide, { once: true });
    window.addEventListener('pagehide', onHide, { once: true });
    if (!navigator.onLine) toast('Sem internet: abrindo no Apple Mapas (use os mapas baixados)');
    location.href = app;
    // só cai no site se houver internet e o app realmente não abriu
    setTimeout(() => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('blur', onHide); window.removeEventListener('pagehide', onHide);
      if (!left && navigator.onLine && document.visibilityState === 'visible' && document.hasFocus()) window.open(web, '_blank'); }, 2500);
  }, true);

  document.addEventListener('click', async e => {
    const tf = e.target.closest('[data-tfile]'); if (tf) { openTicketFile(tf.dataset.tfile, +tf.dataset.tidx); return; }
    const ct = e.target.closest('[data-ctips]'); if (ct) { openCountry(ct.dataset.ctips); return; }
    const sv = e.target.closest('[data-souv]'); if (sv) { openSouv(sv.dataset.souv); return; }
    const ph = e.target.closest('[data-photos],[data-sphotos]'); if (ph) { if (ph.dataset.photos) openPhotos(ph.dataset.photos); else openStopPhotos(ph.dataset.sphotos); return; }
    const hz = e.target.closest('[data-hist],[data-lore],[data-hsay]');
    if (hz) {
      if (hz.dataset.hist) { openHistory(hz.dataset.hist); return; }
      if (hz.dataset.lore) { openLore(hz.dataset.lore); return; }
      const k = hz.dataset.hsay; if (speakingKey === k) { stopSpeak(); return; }
      if (hsay[k]) speakChunks(hsay[k], k); return;
    }
    const g = e.target.closest('[data-guide],[data-say],[data-gps]');
    if (g) {
      if (g.dataset.guide) { openGuide(g.dataset.guide); return; }
      if (g.dataset.gps) { toggleGps(); return; }
      if (g.dataset.say !== undefined) {
        if (speakingKey === g.dataset.say) { stopSpeak(); return; }
        const G = T.guides[curGuide];
        speakChunks(g.dataset.say === 'intro' ? G.intro : stopText(G.stops[+g.dataset.say]), g.dataset.say);
        return;
      }
    }
    const el = e.target.closest('[data-modal],[data-city],[data-dcity],[data-copy],[data-goto],[data-act],[data-tstatus],[data-delexp],[data-file]');
    if (!el) return;
    if (el.dataset.copy) { try { await navigator.clipboard.writeText(el.dataset.copy); toast('Destino copiado — cole no app'); } catch (x) { } if (el.tagName === 'BUTTON') return; }
    if (el.dataset.modal) { showModal(el.dataset.modal); return; }
    if (el.dataset.city !== undefined) { cityFilter = el.dataset.city || null; LS.set('city', cityFilter); render.jump = false; render(); return; }
    if (el.dataset.dcity !== undefined) { dicasCity = el.dataset.dcity || null; render(); return; }
    if (el.dataset.goto === 'settings') { renderSettings(); return; }
    if (el.dataset.goto === 'ingressos') { tab = 'ingressos'; LS.set('tab', tab); render(); window.scrollTo(0, 0); return; }
    if (el.dataset.goto === 'roteiro') { tab = 'roteiro'; cityFilter = null; render.jump = el.dataset.day; render(); return; }
    if (el.dataset.act === 'rates') { updateRates(); return; }
    if (el.dataset.act === 'manualrate') {
      const cur = prompt('Qual moeda? (EUR, GBP, CZK, PLN, HUF)', currentCurrency()); if (!cur) return;
      const C = cur.trim().toUpperCase(); if (!CURRENCIES.includes(C) || C === 'BRL') { toast('Moeda inválida'); return; }
      const v = parseFloat(String(prompt('Quantos reais vale 1 ' + C + '?') || '').replace(',', '.')); if (!(v > 0)) return;
      const r = rates() || { base: 'BRL', r: {}, date: '' }; r.r[C] = 1 / v; r.date = 'manual ' + new Date().toLocaleDateString('pt-BR'); setItem('rates', r); render(); return;
    }
    if (el.dataset.act === 'addexp') {
      const v = parseFloat(String($('#e-v').value).replace(',', '.'));
      if (!(v > 0)) { toast('Digite o valor'); return; }
      const id = 'exp:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      setItem(id, { v, cur: $('#e-cur').value, cat: $('#e-cat').value, d: $('#e-d').value.trim(), who: settings.device || '', ts: new Date().toISOString() });
      toast('Gasto salvo'); render(); return;
    }
    if (el.dataset.delexp) { if (confirm('Apagar este gasto?')) { setItem(el.dataset.delexp, null, true); render(); } return; }
    if (el.dataset.tstatus) {
      const t = T.tickets.find(x => x.id === el.dataset.tstatus); const cur = getItem('ticket:' + t.id) || t.status;
      const nx = { todo: 'ok', ok: 'todo', info: 'todo', check: 'ok' }[cur]; setItem('ticket:' + t.id, nx); render(); return;
    }
    if (el.dataset.file) {
      const f = filesCache.find(x => x.id === el.dataset.file); if (!f) return;
      const url = URL.createObjectURL(f.blob);
      openSheet(f.name, (f.type.startsWith('image/') ? `<img src="${url}" style="width:100%;border-radius:10px">` : `<a class="btn full" href="${url}" target="_blank">Abrir PDF</a>`) +
        `<button class="btn danger full" style="margin-top:12px" data-rmfile="${f.id}">Remover anexo</button>`);
      $('[data-rmfile]').onclick = async () => { if (confirm('Remover este anexo deste celular?')) { await fileDel(f.id); closeSheet(); render(); } };
    }
  });
  document.addEventListener('change', async e => {
    const t = e.target;
    if (t.dataset.gseen !== undefined) { setItem('guide:' + curGuide + ':' + t.dataset.gseen, t.checked || null, !t.checked); refreshGuide(); return; }
    if (t.dataset.done) { setItem('done:' + t.dataset.done, t.checked || null, !t.checked); t.closest('.stop').classList.toggle('done', t.checked); return; }
    if (t.dataset.check) { setItem('check:' + t.dataset.check, t.checked || null, !t.checked); render(); return; }
    if (t.dataset.attach && t.files[0]) {
      const f = t.files[0];
      await filePut({ id: 'f' + Date.now().toString(36), ticket: t.dataset.attach, name: f.name, type: f.type, blob: f });
      toast('Anexo salvo neste celular'); render();
    }
  });

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      const ask = w => { $('#update-bar').hidden = false; $('#update-go').onclick = () => w.postMessage('skip'); };
      if (reg.waiting) ask(reg.waiting);
      reg.addEventListener('updatefound', () => { const w = reg.installing; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); }); });
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  render();
  if (!settings.device) setTimeout(renderSettings, 400);
  scheduleSync(800);
})();
