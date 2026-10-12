// Minimal, client-only estimator.
// Fetches public eBay sold listings via search result pages (no API keys),
// parses price data heuristically, then computes a target buy price net of fees and ROI.

(function () {
  const form = document.getElementById('estimate-form');
  const runButton = document.getElementById('runButton');
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  const calc = document.getElementById('calc');
  const listingsDiv = document.getElementById('listings');
  const debugSection = document.getElementById('debug-section');
  const debugLogEl = document.getElementById('debugLog');
  const copyDebugBtn = document.getElementById('copyDebug');
  const yearSpan = document.getElementById('year');
  yearSpan.textContent = String(new Date().getFullYear());

  /** Utility functions **/
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function usd(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  }

  function parseNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function computeStats(numbers) {
    const arr = numbers.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    if (arr.length === 0) return null;
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = sum / arr.length;
    const mid = Math.floor(arr.length / 2);
    const median = arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
    const p10 = arr[Math.floor(arr.length * 0.10)];
    const p25 = arr[Math.floor(arr.length * 0.25)];
    const p75 = arr[Math.floor(arr.length * 0.75)];
    const p90 = arr[Math.floor(arr.length * 0.90)];
    return { count: arr.length, min: arr[0], p10, p25, median, avg, p75, p90, max: arr[arr.length - 1] };
  }

  function estimateBuyPrice(targetRoiPct, feePct, perTxnFee, shippingOut, resalePrice) {
    // Revenue net of percent + per-txn fees: resalePrice * (1 - feePct) - perTxnFee
    // Profit target: ROI% of buyPrice => profit = buyPrice * ROI
    // profit = netRevenue - shippingOut - buyPrice
    // buyPrice * ROI = netRevenue - shippingOut - buyPrice
    // buyPrice * (ROI + 1) = netRevenue - shippingOut
    // buyPrice = (netRevenue - shippingOut) / (1 + ROI)
    const roi = targetRoiPct / 100;
    const netRevenue = resalePrice * (1 - feePct / 100) - perTxnFee;
    const buyPrice = (netRevenue - shippingOut) / (1 + roi);
    return buyPrice;
  }

  function setLoading(loading) {
    runButton.disabled = loading;
    runButton.textContent = loading ? 'Estimating…' : 'Run estimation';
  }

  /** Debug logger **/
  const debug = (() => {
    let lines = [];
    function toStr(v) {
      if (v == null) return String(v);
      if (typeof v === 'string') return v;
      try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
    }
    function updateDom() {
      if (debugLogEl) debugLogEl.textContent = lines.join('\n');
    }
    return {
      clear() { lines = []; updateDom(); },
      write(...args) {
        const ts = new Date().toISOString();
        const msg = args.map(toStr).join(' ');
        lines.push(`[${ts}] ${msg}`);
        if (lines.length > 2000) lines.splice(0, lines.length - 2000);
        updateDom();
        try { console.log('[debug]', msg); } catch (_) {}
      },
      section(title) { lines.push(`\n=== ${title} ===`); updateDom(); },
      getText() { return lines.join('\n'); },
      show() { if (debugSection) debugSection.classList.remove('hidden'); },
      async copy() {
        const text = this.getText();
        try {
          await navigator.clipboard.writeText(text);
          this.write('Copied debug log to clipboard');
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          try { document.execCommand('copy'); this.write('Copied debug log to clipboard (fallback)'); } catch (e) { this.write('Failed to copy log', e?.message || String(e)); }
          document.body.removeChild(ta);
        }
      },
    };
  })();

  if (copyDebugBtn) {
    copyDebugBtn.addEventListener('click', () => { debug.copy(); });
  }

  function listingToHtml(listing) {
    const wrapper = document.createElement('div');
    wrapper.className = 'listing';
    const priceStr = listing.price != null ? usd(listing.price) : '—';
    wrapper.innerHTML = `
      <div class="title"><a href="${listing.url}" target="_blank" rel="noopener">${listing.title}</a></div>
      <div class="meta">${listing.date || ''} · ${listing.condition || ''} · ${priceStr}${listing.shipping != null ? ' + ' + usd(listing.shipping) + ' ship' : ''}</div>
    `;
    return wrapper;
  }

  async function fetchSoldListings({ setNumber, condition, includeAuctions, excludeParts, days }) {
    // Heuristic eBay search URL for sold listings
    // Example: https://www.ebay.com/sch/i.html?_nkw=21318&_sop=13&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3|1000
    const query = encodeURIComponent(setNumber);
    const condParam = condition === 'new' ? '&LH_ItemCondition=1000' : condition === 'used' ? '&LH_ItemCondition=3000' : '';
    const auctionsParam = includeAuctions ? '' : '&LH_Auction=0&LH_BIN=1';
    const soldUrl = `https://www.ebay.com/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1${condParam}${auctionsParam}`;
    // Try RSS via text proxy first for a simpler parse, then HTML fallback
    debug.section('Fetch eBay sold listings');
    debug.write('Sold URL:', soldUrl);
    let listings = await tryFetchFromRss({ query, setNumber });
    if (Array.isArray(listings) && listings.length > 0) {
      debug.write('RSS parsed listings:', String(listings.length));
    } else {
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      let html = await fetchHtmlThroughCors(soldUrl);
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      debug.write('Fetched HTML length:', String(html?.length || 0), 'in', String(Math.round(t1 - t0)), 'ms');
      listings = parseEbaySearchHtml(html, setNumber).filter(l => l && l.title);
      debug.write('Parsed listings:', String(listings.length));
      if (listings.length === 0) {
        const altUrls = [
          soldUrl + '&rt=nc',
          soldUrl + '&_sop=13',
          `https://m.ebay.com/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1${condParam}${auctionsParam}`,
        ];
        for (const alt of altUrls) {
          debug.write('Trying alternate URL:', alt);
          const tAlt0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          html = await fetchHtmlThroughCors(alt);
          const tAlt1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          debug.write('Alt fetched length:', String(html?.length || 0), 'in', String(Math.round(tAlt1 - tAlt0)), 'ms');
          const parsed = parseEbaySearchHtml(html, setNumber).filter(l => l && l.title);
          debug.write('Alt parsed listings:', String(parsed.length));
          if (parsed.length > 0) { listings = parsed; break; }
        }
      }
    }

    // Filter by heuristics
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    debug.write('Filter cutoff (older than excluded):', new Date(cutoff).toISOString(), 'days window:', String(days));
    const filtered = listings.filter(l => {
      if (excludeParts && /parts? only|for parts|minifig(s)? only/i.test(l.title)) return false;
      if (l.dateTs && l.dateTs < cutoff) return false;
      return true;
    });
    debug.write('After filters:', String(filtered.length));

    return filtered;
  }

  async function tryFetchFromRss({ query, setNumber }) {
    try {
      // eBay provides RSS for searches via &_rss=1 (often surfaces basic data)
      const rssUrl = `https://www.ebay.com/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1&_rss=1`;
      const rssText = await fetchHtmlThroughCors(rssUrl);
      debug.write('RSS length:', String(rssText?.length || 0));
      if (!rssText) return [];
      // Parse RSS minimally with regex (no external libs)
      const items = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/gi;
      let m;
      while ((m = itemRe.exec(rssText)) !== null) {
        const chunk = m[1];
        const title = (chunk.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const link = (chunk.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
        const pubDate = (chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').trim();
        // Try to extract price from title text like "$123.45"
        const priceMatch = title.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        const price = priceMatch ? parseNumber(priceMatch[0]) : null;
        const dateTs = pubDate ? Date.parse(pubDate) : null;
        if (title && (setNumber ? title.toLowerCase().includes(String(setNumber).toLowerCase()) : true)) {
          items.push({ title, url: link, price, shipping: 0, condition: '', date: pubDate, dateTs });
        }
      }
      return items;
    } catch (e) {
      debug.write('RSS fetch failed:', e?.message || String(e));
      return [];
    }
  }

  async function fetchHtmlThroughCors(url) {
    // Use a simple public CORS passthrough to allow client-side fetch of eBay HTML.
    // Avoid storing any keys. If the passthrough is unreliable, the user can run locally or add their own proxy.
    const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
    debug.write('Proxy URL:', proxied);
    const res = await fetch(proxied, { headers: { 'x-requested-with': 'brick-check' } });
    debug.write('Fetch status:', String(res.status));
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    return await res.text();
  }

  function parseEbaySearchHtml(html, setNumber) {
    // Lightweight HTML parse using DOMParser where available; fallback to regex heuristics via a detached DOM.
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const liItems = Array.from(doc.querySelectorAll('li.s-item'));
      debug.write('Parser: li.s-item count:', String(liItems.length));
      let candidates = liItems;
      if (candidates.length === 0) {
        const anchorItems = Array.from(doc.querySelectorAll('a.s-item__link'));
        debug.write('Parser: a.s-item__link count:', String(anchorItems.length));
        const viaAnchors = anchorItems.map(a => a.closest('li') || a.closest('div'));
        candidates = Array.from(new Set(viaAnchors.filter(Boolean)));
      }
      if (candidates.length === 0) {
        const wrappers = Array.from(doc.querySelectorAll('div.s-item__wrapper'));
        debug.write('Parser: div.s-item__wrapper count:', String(wrappers.length));
        candidates = wrappers;
      }

      const out = candidates.map(node => {
        const titleEl = node.querySelector('.s-item__title, h3.s-item__title, [role="heading"].s-item__title');
        const priceEl = node.querySelector('.s-item__price');
        const shipEl = node.querySelector('.s-item__shipping, .s-item__logisticsCost');
        const timeEl = node.querySelector('span.s-item__ended-date, span.s-item__ended-date span');
        const linkEl = node.querySelector('a.s-item__link');
        const condEl = node.querySelector('.SECONDARY_INFO, .s-item__subtitle .SECONDARY_INFO');
        let title = titleEl?.textContent?.trim() || '';
        // Filter promotional/placeholder titles commonly present in eBay markup
        if (/shop on ebay/i.test(title)) return null;
        const price = parseNumber(priceEl?.textContent || '');
        const shipping = parseNumber(shipEl?.textContent || '') || 0;
        const url = linkEl?.getAttribute('href') || '';
        const condition = condEl?.textContent?.trim() || '';
        const dateText = timeEl?.textContent?.trim() || '';
        const dateTs = parseEbayDateToTs(dateText);
        return { title, price, shipping, url, condition, date: dateText, dateTs };
      }).filter(Boolean);
      debug.write('Parser: extracted candidates:', String(out.length));
      if (out.length > 0) return out;
      debug.write('Parser: switching to fallback text-based extraction');
      const textOut = parseEbaySearchText(html);
      if (textOut.length > 0) return textOut;
      debug.write('Parser: switching to loose text extraction');
      const looseOut = parseEbaySearchTextLoose(html, setNumber);
      if (looseOut.length > 0) return looseOut;
      debug.write('Parser: switching to JSON-LD extraction');
      return parseEbaySearchJsonLd(html);
    } catch (e) {
      console.error('parse error', e);
      debug.write('Parser: exception', e?.message || String(e));
      const textOut = parseEbaySearchText(html);
      if (textOut.length > 0) return textOut;
      const looseOut = parseEbaySearchTextLoose(html, setNumber);
      if (looseOut.length > 0) return looseOut;
      return parseEbaySearchJsonLd(html);
    }
  }

  function parseEbaySearchText(html) {
    try {
      const candidates = [];
      const seenUrls = new Set();
      const anchorRegex = /<a[^>]+href="([^"]+?\/itm\/[^"]+?)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      let anchorCount = 0;
      while ((m = anchorRegex.exec(html)) !== null) {
        anchorCount++;
        const url = m[1];
        const titleHtml = m[2] || '';
        let title = titleHtml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (!url || !title || /shop on ebay/i.test(title)) continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        const after = html.slice(m.index + m[0].length, Math.min(html.length, m.index + m[0].length + 1200));

        let price = null;
        const priceMatch = after.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        if (priceMatch) price = parseNumber(priceMatch[0]);

        let shipping = 0;
        if (/free shipping/i.test(after)) {
          shipping = 0;
        } else {
          const shipMatch = after.match(/\+?\s*\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:shipping|ship)/i);
          if (shipMatch) shipping = parseNumber(shipMatch[0]) || 0;
        }

        let dateText = '';
        const dateMatch = after.match(/Sold[^<\n]*?(\d{1,2}\/\d{1,2}\/\d{2,4}|Today|Yesterday)/i);
        if (dateMatch) dateText = dateMatch[0].trim();
        const dateTs = parseEbayDateToTs(dateText);

        let condition = '';
        const condMatch = after.match(/\b(Brand New|New|Used|Pre-owned)\b/i);
        if (condMatch) condition = condMatch[0];

        candidates.push({ title, price, shipping, url, condition, date: dateText, dateTs });
      }
      debug.write('Fallback parser: anchors scanned:', String(anchorCount));
      debug.write('Fallback parser: extracted items:', String(candidates.length));
      return candidates;
    } catch (e) {
      debug.write('Fallback parser: exception', e?.message || String(e));
      return [];
    }
  }

  function htmlToPlainText(html) {
    try {
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (_) { return ''; }
  }

  function parseEbaySearchTextLoose(html, setNumber) {
    try {
      const text = htmlToPlainText(html);
      if (!text) { debug.write('Loose parser: empty text'); return []; }
      const results = [];
      const soldRe = /Sold\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|Today|Yesterday)/gi;
      let m;
      let hits = 0;
      while ((m = soldRe.exec(text)) !== null) {
        hits++;
        const idx = m.index;
        const before = text.slice(Math.max(0, idx - 260), idx);
        const after = text.slice(idx, Math.min(text.length, idx + 260));

        // Require the set number near the match to reduce false positives
        const near = (before + ' ' + after).toLowerCase();
        if (setNumber && !near.includes(String(setNumber).toLowerCase())) continue;

        // Title heuristic: take up to 120 chars before 'Sold', stop at previous $ or pipe
        let title = before.replace(/.*[\$|]/, '').trim();
        if (!title || title.length < 6) {
          title = before.trim();
        }
        title = title.slice(-140).trim();

        // Price: first $ amount after the Sold marker window
        let price = null;
        const priceMatch = after.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        if (priceMatch) price = parseNumber(priceMatch[0]);

        // Shipping
        let shipping = 0;
        if (/free shipping/i.test(after)) {
          shipping = 0;
        } else {
          const shipMatch = after.match(/\+\s*\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:shipping|ship)/i);
          if (shipMatch) shipping = parseNumber(shipMatch[0]) || 0;
        }

        // Date
        const dateText = m[0];
        const dateTs = parseEbayDateToTs(dateText);

        if (price != null) {
          results.push({ title, price, shipping, url: '', condition: '', date: dateText, dateTs });
        }
      }
      debug.write('Loose parser: sold markers:', String(hits));
      debug.write('Loose parser: extracted items:', String(results.length));
      return results;
    } catch (e) {
      debug.write('Loose parser: exception', e?.message || String(e));
      return [];
    }
  }

  function parseEbaySearchJsonLd(html) {
    try {
      const scripts = [];
      const scriptRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = scriptRegex.exec(html)) !== null) {
        const content = m[1];
        if (content) scripts.push(content.trim());
      }
      debug.write('JSON-LD: scripts found:', String(scripts.length));
      const items = [];
      for (const s of scripts) {
        let data;
        try {
          data = JSON.parse(s);
        } catch (_) {
          continue;
        }
        const visit = (node) => {
          if (!node) return;
          if (Array.isArray(node)) { node.forEach(visit); return; }
          if (typeof node !== 'object') return;
          if (node.itemListElement && Array.isArray(node.itemListElement)) {
            for (const li of node.itemListElement) {
              const it = li.item || li;
              if (!it) continue;
              const title = (it.name || it.title || '').trim();
              const url = (it.url || '').trim();
              let price = null;
              let shipping = 0;
              const offers = it.offers || node.offers;
              if (offers) {
                if (Array.isArray(offers)) {
                  const o = offers[0];
                  if (o) price = parseNumber(String(o.price || (o.priceSpecification && o.priceSpecification.price) || ''));
                } else {
                  price = parseNumber(String(offers.price || (offers.priceSpecification && offers.priceSpecification.price) || offers.lowPrice || ''));
                }
              }
              if (title && url) {
                items.push({ title, url, price, shipping, condition: '', date: '', dateTs: null });
              }
            }
          }
          for (const k of Object.keys(node)) visit(node[k]);
        };
        visit(data);
      }
      debug.write('JSON-LD: extracted items:', String(items.length));
      return items;
    } catch (e) {
      debug.write('JSON-LD: exception', e?.message || String(e));
      return [];
    }
  }

  function parseEbayDateToTs(text) {
    if (!text) return null;
    // e.g., "Sold 08/21/24" or relative like "Yesterday"
    const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const month = parseInt(m[1], 10) - 1;
      const day = parseInt(m[2], 10);
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, month, day).getTime();
    }
    if (/yesterday/i.test(text)) return Date.now() - 24 * 3600 * 1000;
    if (/today/i.test(text)) return Date.now();
    return null;
  }

  function renderSummary(stats, estimate, inputs, sampleCount) {
    summary.innerHTML = '';
    const items = [
      { label: 'Listings used', value: String(sampleCount) },
      { label: 'Median sold', value: stats ? usd(stats.median) : '—' },
      { label: 'Average sold', value: stats ? usd(stats.avg) : '—' },
      { label: 'Target buy (at median)', value: estimate ? usd(estimate) : '—' },
      { label: 'ROI target', value: inputs.targetRoi + '%' },
    ];
    for (const item of items) {
      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.innerHTML = `<span class="label">${item.label}</span><span class="value">${item.value}</span>`;
      summary.appendChild(pill);
    }
  }

  function renderCalc(stats, inputs, estimateAtMedian, estimateAtP25) {
    if (!stats) { calc.textContent = 'No sold listings parsed.'; return; }
    const lines = [];
    lines.push('Assumptions:');
    lines.push(`  Fee: ${inputs.feePct}% + ${usd(inputs.perTxnFee)} per txn`);
    lines.push(`  Shipping out: ${usd(inputs.shippingOut)}`);
    lines.push(`  Target ROI: ${inputs.targetRoi}%`);
    lines.push('');
    lines.push('Sold distribution:');
    lines.push(`  n=${stats.count} min=${usd(stats.min)} p25=${usd(stats.p25)} median=${usd(stats.median)} p75=${usd(stats.p75)} max=${usd(stats.max)}`);
    lines.push('');
    lines.push('Estimated max buy price:');
    lines.push(`  Using median: ${usd(estimateAtMedian)}`);
    lines.push(`  Using p25:   ${usd(estimateAtP25)}`);
    calc.textContent = lines.join('\n');
  }

  function renderListings(listings) {
    listingsDiv.innerHTML = '';
    listings.forEach(l => listingsDiv.appendChild(listingToHtml(l)));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const inputs = {
      setNumber: String(fd.get('setNumber') || '').trim(),
      condition: String(fd.get('condition') || 'any'),
      days: Number(fd.get('searchDays') || 90),
      includeAuctions: !!fd.get('includeAuctions'),
      excludeParts: !!fd.get('excludeParts'),
      feePct: Number(fd.get('feePercent') || 13.25),
      perTxnFee: Number(fd.get('perTxnFee') || 0.30),
      shippingOut: Number(fd.get('shippingOut') || 12.0),
      targetRoi: Number(fd.get('targetRoi') || 30),
    };

    if (!inputs.setNumber) {
      alert('Please enter a LEGO set number.');
      return;
    }

    setLoading(true);
    results.classList.add('hidden');
    debug.clear();
    debug.section('Run estimation');
    debug.write('Inputs:', inputs);
    debug.show();

    try {
      const listings = await fetchSoldListings(inputs);
      const prices = listings.map(l => l.price).filter(n => Number.isFinite(n));
      const stats = computeStats(prices);
      const estMedian = stats ? estimateBuyPrice(inputs.targetRoi, inputs.feePct, inputs.perTxnFee, inputs.shippingOut, stats.median) : null;
      const estP25 = stats ? estimateBuyPrice(inputs.targetRoi, inputs.feePct, inputs.perTxnFee, inputs.shippingOut, stats.p25) : null;
      debug.section('Computation');
      debug.write('Prices count:', String(prices.length));
      if (stats) debug.write('Stats:', { count: stats.count, min: stats.min, p25: stats.p25, median: stats.median, avg: stats.avg, p75: stats.p75, max: stats.max });
      debug.write('Estimates:', { atMedian: estMedian, atP25: estP25 });

      renderSummary(stats, estMedian, inputs, prices.length);
      renderCalc(stats, inputs, estMedian ?? 0, estP25 ?? 0);
      renderListings(listings);
      debug.write('Rendered listings:', String(listings.length));

      results.classList.remove('hidden');
    } catch (err) {
      console.error(err);
      debug.section('Error');
      debug.write('Error message:', err?.message || String(err));
      alert('Failed to fetch or parse listings. Try again later.');
    } finally {
      setLoading(false);
    }
  });
})();


