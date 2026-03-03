// ---------------- Gutenberg sanitisation --------------------
// Searches every line for "Project Gutenberg", removes it, then reassembles
// (there are often header/footer lines with that phrase that skew n-gram tables)
function stripProjectGutenberg(text) {
    const lines = text.split(/\r?\n/);
    const kept = lines.filter(line => !/project\s+gutenberg/i.test(line));
    return kept.join("\n").replace(/project\s+gutenberg/ig, "");
}
  
// --------------------- Tokeniser -------------------------
function splitIntoSentences(text) {
    let t = text;

    // Protect full stops that shouldn't end sentences
    const abbrev = [
        "mr", "mrs", "ms", "dr", "mx", "prof", "sr", "jr",
        "st", "mt", "no", "vs", "etc", "e.g", "i.e"
    ];
    for (const a of abbrev) {
        t = t.replace(new RegExp(`\\b${a}\\.`, "g"), `${a}<prd>`);
    }

    // Split into sentences
    return t
        .split(/[\!\?\.]+(?:\s+|$)/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replaceAll("<prd>", "."));
}

function wordsFromSentence(s) {
    // Unicode letters + digits, with apostrophes
    return s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}
  
// Tokenise text, inserting boundary markers where appropriate
function tokenizeN(text, n) {
    const lower = (text ?? "").toLowerCase();
    const sentences = splitIntoSentences(lower);

    const tokens = [];
    const startPads = Math.max(1, n - 1); // n>=2 -> at least 1
    for (const s of sentences) {
        const words = wordsFromSentence(s);
        if (words.length === 0) continue;
        for (let k = 0; k < startPads; k++) tokens.push("<s>");
        tokens.push(...words, "</s>");
    }
    return tokens;
}
  
// ---------------------- Build n-grams ----------------------
const SEP = "\u0001"; // unlikely to appear in text; avoids collisions
function makeKey(contextArr) {
    // contextArr is length (n-1)
    return contextArr.join(SEP);
}
function parseKey(key) {
    return key.split(SEP);
}

function buildNgrams(tokens, n) {
    const contextCounts = new Map(); // Dictionary mapping context keys to dictionary of next-token counts
    const contextTotals = new Map(); // Dictionary mapping context keys to total count

    const ctxLen = n - 1;
    if (tokens.length < n) return { contextCounts, contextTotals };

    for (let i = 0; i <= tokens.length - n; i++) {
        const context = tokens.slice(i, i + ctxLen);
        const next = tokens[i + ctxLen];

        const key = makeKey(context);

        if (!contextCounts.has(key)) contextCounts.set(key, new Map());
        const inner = contextCounts.get(key);

        inner.set(next, (inner.get(next) ?? 0) + 1);
        contextTotals.set(key, (contextTotals.get(key) ?? 0) + 1);
    }

    return { contextCounts, contextTotals };
}
  
// ---------------------- Flatten n-grams ---------------------
function flattenNgrams(contextCounts, contextTotals) {
    const rows = [];
    for (const [key, inner] of contextCounts.entries()) {
        const total = contextTotals.get(key) ?? 0;
        const contextTokens = parseKey(key);
        const contextStr = contextTokens.join(" ");

        for (const [next, count] of inner.entries()) {
        rows.push({
            contextKey: key,
            context: contextStr,
            next,
            count,
            prob: total ? count / total : 0
        });
        }
    }

    rows.sort((a, b) =>
        (b.count - a.count) ||
        (b.prob - a.prob) ||
        a.context.localeCompare(b.context) ||
        a.next.localeCompare(b.next)
    );

    return rows;
}
  
// -------------------- Escaping html ----------------------
function escapeHtml(s) {
    return (s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}
  
// -------------------- Produce table ----------------------
function renderTable(rows, topN, n) {
    const shown = rows.slice(0, topN);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");

    const ctxLabel = `Context (${n - 1} token${(n - 1) === 1 ? "" : "s"})`;
    [ctxLabel, "Next token", "Count", "P(next | context)"].forEach(h => {
        const th = document.createElement("th");
        th.textContent = h;
        trh.appendChild(th);
    });

    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const r of shown) {
        const tr = document.createElement("tr");

        const tdCtx = document.createElement("td");
        tdCtx.innerHTML = `<code>${escapeHtml(r.context)}</code>`;
        tr.appendChild(tdCtx);

        const tdNext = document.createElement("td");
        tdNext.innerHTML = `<code>${escapeHtml(r.next)}</code>`;
        tr.appendChild(tdNext);

        const tdCount = document.createElement("td");
        tdCount.textContent = String(r.count);
        tr.appendChild(tdCount);

        const tdProb = document.createElement("td");
        tdProb.textContent = r.prob.toFixed(4);
        tr.appendChild(tdProb);

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    return table;
}
  
// --------------------- UI info -----------------------
function setStatus(msg) {
    const el = document.getElementById("status");
    if (el) el.textContent = msg || "";
}
function setStatus2(msg) {
    const el = document.getElementById("status2");
    if (el) el.textContent = msg || "";
}
  
// ------ Load preset or custom corpus -----------------
async function loadSelectedCorpus() {
    const select = document.getElementById("corpusSelect");
    const choice = select.value;
    const ta = document.getElementById("textInput");
    const hint = document.getElementById("hint");

    if (choice === "custom") {
        ta.readOnly = false;
        ta.value = "";
        hint.innerHTML = 'Paste or type your own text above, then click <code>Build N-gram table</code>.';
        setStatus("");
        return;
    }

    ta.readOnly = true;
    hint.innerHTML = 'Preset chosen. Select <code>Build your own…</code> to enter your own text.';
    const url = new URL(choice, window.location.href).toString();
    setStatus(`Loading…`);

    try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const raw = await res.text();

        const cleaned = stripProjectGutenberg(raw);
        ta.value = cleaned;

        setStatus(`Loaded.`);
    } catch (err) {
        setStatus(`Could not load ${choice}.`);
        alert(
        `Could not load "${choice}".\n\n` +
        `Make sure:\n` +
        `1) The .txt file is in the SAME folder as this HTML (or correct relative path).\n` +
        `2) You opened the page via a local server (e.g. VS Code Live Server), not by double-clicking.\n\n` +
        `Error: ${err.message}`
        );
    }
}
  
  // ---------------- Build table ---------------------
  let LAST_MODEL = null; // holds { n, contextCounts, contextTotals, vocab }
  function build() {
    const rawText = document.getElementById("textInput").value;
    const textForAnalysis = stripProjectGutenberg(rawText);
  
    const n = Math.max(2, Math.min(6, Number(document.getElementById("nVal").value) || 3));
    document.getElementById("nVal").value = n;
    const topN = Math.max(1, Math.min(5000, Number(document.getElementById("topN").value) || 20));
    document.getElementById("topN").value = topN;
  
    const tokens = tokenizeN(textForAnalysis, n);
    const { contextCounts, contextTotals } = buildNgrams(tokens, n);
    const rows = flattenNgrams(contextCounts, contextTotals);
  
    LAST_MODEL = {
      n,
      contextCounts,
      contextTotals,
      vocab: new Set(tokens)
    };
  
    document.getElementById("meta").innerHTML = `
      Tokens: <b>${tokens.length}</b> &nbsp;•&nbsp;
      Unique tokens: <b>${new Set(tokens).size}</b> &nbsp;•&nbsp;
      Unique N-grams: <b>${rows.length}</b>
    `;
  
    const container = document.getElementById("tableContainer");
    container.innerHTML = "";
    if (rows.length === 0) {
      container.textContent = `Not enough tokens to form ${n}-grams (need at least ${n}).`;
      return;
    }
    container.appendChild(renderTable(rows, topN, n));
  }
  
  function clearOutput() {
    const table = document.getElementById("tableContainer");
    const meta = document.getElementById("meta");
    if (table) table.innerHTML = "";
    if (meta) meta.innerHTML = "";
    setStatus("");
    const out = document.getElementById("genOutput");
    if (out) out.value = "";
    LAST_MODEL = null;
  }
  
  // -------------- Generative model ---------------------
  function sampleNextToken(innerMap) {
    let total = 0;
    for (const c of innerMap.values()) total += c;
    if (total <= 0) return null;
  
    let r = Math.random() * total;
    for (const [tok, c] of innerMap.entries()) {
      r -= c;
      if (r <= 0) return tok;
    }
    return innerMap.keys().next().value ?? null;
  }

  function greedyNextToken(innerMap) {
    let bestTok = null;
    let bestCount = -1;
    for (const [tok, c] of innerMap.entries()) {
      if (c > bestCount) { bestCount = c; bestTok = tok; }
    }
    return bestTok;
  }
  
  function chooseNextToken(innerMap, mode = "random") {
    return (mode === "greedy") ? greedyNextToken(innerMap) : sampleNextToken(innerMap);
  }
  
  // ----------- Clean up generated text -----------------
  function detokenize(tokens) {
    let text = "";
    let capitalizeNext = true;
  
    for (const tok of tokens) {
      if (tok === "</s>") {
        text = text.trimEnd() + ". ";
        capitalizeNext = true;
        continue;
      }
      if (tok === "<s>") continue;
  
      let word = tok;
      if (capitalizeNext && word.length > 0) {
        word = word.charAt(0).toUpperCase() + word.slice(1);
        capitalizeNext = false;
      }
      text += word + " ";
    }
    return text.trim();
  }
  
  // Seed tokenisation: just grab words from the seed (no sentence splitting, no boundary markers)
  function tokenizeSeedWords(seedText) {
    const lower = (seedText ?? "").toLowerCase();
    return lower.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  }
  
  // ----------- Generate text -----------------
  function generateFromNgrams(model, nTokens, seedText = "", stopAtEos = true, mode = "random") {
    const { n, contextCounts } = model;
    setStatus2("");
  
    const ctxLen = n - 1;
  
    // Start context: <s> repeated (n-1)
    let context = Array(ctxLen).fill("<s>");
  
    // If seed provided, take its last (n-1) words and use them as the ending of the context
    const seedWords = tokenizeSeedWords(seedText);
    if (seedWords.length > 0) {
      const tail = seedWords.slice(Math.max(0, seedWords.length - ctxLen));
      context = context.slice(0, Math.max(0, ctxLen - tail.length)).concat(tail);
    }
  
    const out = [];
    for (let k = 0; k < nTokens; k++) {
      const key = makeKey(context);
      let inner = contextCounts.get(key);
  
      // Fallback if context unseen: back off by resetting to sentence start
      if (!inner || inner.size === 0) {
        setStatus2(`No continuation found for "${context.join(" ")}". Using <s>… as fallback.`);
        context = Array(ctxLen).fill("<s>");
        inner = contextCounts.get(makeKey(context));
        if (!inner || inner.size === 0) break; // truly no start context, corpus too small
      }
  
      const next = chooseNextToken(inner, mode);;
      if (!next) break;
  
      out.push(next);
  
      if (next === "</s>") {
        if (stopAtEos) break;
        // After EOS, reset context to start pads
        context = Array(ctxLen).fill("<s>");
        continue;
      }
  
      // Slide the context window
      context = context.slice(1).concat(next);
    }
  
    return detokenize(out);
  }