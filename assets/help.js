// Runtime of the generated help center. Two parts:
//   1. HC_CORE: the search and the hash decoding, pure functions with no DOM (the tests load them).
//   2. the chrome (top bar, sidebar, search box, footer), tabs, deep links and copy links around <main>.
// Reads window.HC_SITE and window.HC_INDEX.

// ---------- 1. core ----------
(function (root) {
  var KIND_RANK = { article: 0, page: 1, section: 2, tab: 3 };
  // A superset of the words pages.mjs leaves out of the index: a query never asks for a word the index dropped.
  var STOP_WORDS = ("a an the and or of to in on at by as is it be if we do does for you your are with that this will can " +
    "not have has any all our may from but its was been they them their also must should would there into than then " +
    "which such how what when where why who my me am i get need want about please tell").split(" ");
  var STOP = {};
  STOP_WORDS.forEach(function (w) { STOP[w] = true; });

  // The folding pages.mjs applies to the index: lowercase, "5,000" -> "5000", the rest becomes spaces ("2-step" = "2 step").
  function normalise(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/(\d),(?=\d{3})/g, "$1").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function tokens(s) {
    var n = normalise(s);
    return n ? n.split(" ") : [];
  }

  // True when one insertion, deletion, substitution or swap of neighbours turns a into b.
  function within1(a, b) {
    var la = a.length, lb = b.length, i = 0;
    if (Math.abs(la - lb) > 1) return false;
    while (i < la && i < lb && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    if (la === lb) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i) && a.slice(i + 2) === b.slice(i + 2);
    }
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  // 3 the same word, 2 its plural or a word that starts with it, 1 one typo away, 0 no match.
  // Whole words only: "ea" never matches "leading". A prefix needs three letters in a title (`loose`)
  // and four in a body, where "bot" would otherwise find every "both".
  function wordHit(word, token, loose) {
    if (token === word) return 3;
    if (token === word + "s" || word === token + "s") return 2;
    if (word.length >= (loose ? 3 : 4) && token.lastIndexOf(word, 0) === 0) return 2;
    if (word.length < 5 || token.charAt(0) !== word.charAt(0)) return 0;
    if (within1(word, token)) return 1;
    if (token.length > word.length && (within1(word, token.slice(0, word.length)) || within1(word, token.slice(0, word.length + 1)))) return 1;
    return 0;
  }
  function best(word, list, loose) {
    var hit = 0, i;
    for (i = 0; i < list.length && hit < 3; i++) hit = Math.max(hit, wordHit(word, list[i], loose));
    return hit;
  }

  // The query itself, then the query with each phrase of a synonym group replaced by the others.
  function variants(query, groups) {
    var base = normalise(query), padded = " " + base + " ", out = [base];
    (groups || []).forEach(function (group) {
      group.forEach(function (phrase) {
        if (!phrase || padded.indexOf(" " + phrase + " ") < 0) return;
        group.forEach(function (other) {
          var v = padded.replace(" " + phrase + " ", " " + other + " ").trim();
          if (other !== phrase && out.indexOf(v) < 0) out.push(v);
        });
      });
    });
    return out;
  }

  // A one-letter word or a number is never required ("2 step" must find "Step 2"), it only breaks ties.
  function split(variant) {
    var words = variant.split(" ").filter(Boolean);
    var kept = words.filter(function (w) { return !STOP[w]; });
    if (!kept.length) kept = words;
    var req = kept.filter(function (w) { return w.length > 1 && !/^\d+$/.test(w); });
    var opt = kept.filter(function (w) { return req.indexOf(w) < 0; });
    return req.length ? { req: req, opt: opt } : { req: kept, opt: [] };
  }

  // Where a word of the query is found in an entry, best place first:
  // 4 its own title, 3 the name of its page or group, 2 its headline words, 1 its body.
  function place(word, e) {
    var h = best(word, e.t, true);
    if (h) return [4, h];
    // A tab is found by its own label only.
    if (e.kind === "tab") return null;
    if ((h = best(word, e.g, true))) return [3, h];
    if ((h = best(word, e.h, false))) return [2, h];
    return (h = best(word, e.b, false)) ? [1, h] : null;
  }

  // Higher is better, compared left to right:
  // [the worst place a word was found in, share of the words in the title, how well they match,
  //  tie-break words in the title, original query before a synonym, kind, order in the index].
  function score(e, q, variantIndex) {
    var tier = 4, inTitle = 0, quality = 0, i, p;
    for (i = 0; i < q.req.length; i++) {
      p = place(q.req[i], e);
      if (!p) return null;
      tier = Math.min(tier, p[0]);
      if (p[0] === 4) inTitle++;
      quality += p[1];
    }
    var bonus = q.opt.filter(function (w) { return e.t.indexOf(w) > -1; }).length;
    return [tier, inTitle / q.req.length, quality / q.req.length, bonus, variantIndex ? 0 : 1, -(KIND_RANK[e.kind] || 0), -e.i];
  }
  function better(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }

  // -> search(query, limit): the entries of `index` ([title, url, group, kind, text?]) that answer the query, best first.
  function makeSearch(index, synonymGroups) {
    var groups = (synonymGroups || []).map(function (g) { return g.map(normalise).filter(Boolean); });
    var prepared = null;
    function entries() {
      return prepared || (prepared = index.map(function (x, i) {
        // The text of a unit is "headline words | body words" (pages.mjs).
        var text = String(x[4] || "").split("|");
        return { x: x, i: i, kind: x[3], t: tokens(x[0]), g: tokens(x[2]), h: tokens(text[0]), b: tokens(text.slice(1).join(" ")) };
      }));
    }
    function run(queries) {
      var found = [];
      entries().forEach(function (e) {
        var top = null;
        queries.forEach(function (q, n) {
          var s = score(e, q, n);
          if (s && (!top || better(s, top))) top = s;
        });
        if (top) found.push({ e: e, s: top });
      });
      return found.sort(function (a, b) { return better(a.s, b.s) ? -1 : better(b.s, a.s) ? 1 : 0; });
    }
    function known(word) {
      return entries().some(function (e) {
        return best(word, e.t, true) || best(word, e.g, true) || best(word, e.h, false) || best(word, e.b, false);
      });
    }
    // "how do I get a refund": a word no page has ("get") must not hide the pages that have the others.
    function withoutUnknown(queries) {
      return queries.map(function (q) {
        return { req: q.req.filter(known), opt: q.opt };
      }).filter(function (q) { return q.req.length; });
    }
    return function (query, limit) {
      var queries = variants(query, groups).filter(Boolean).map(split);
      var found = run(queries);
      if (!found.length) found = run(withoutUnknown(queries));
      return found.slice(0, limit || 8).map(function (r) { return r.e.x; });
    };
  }

  // A hash someone mangled ("#100%") must not stop the page.
  function decodeHash(hash) {
    var raw = String(hash || "").replace(/^#/, "");
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  // Pages live at several depths; the index, the navigation and the brand files are written
  // relative to the site root. `prefix` is the way back to the root from the current page
  // ("" | "../" | "../../"). An address that is absolute, or only a hash, is left alone.
  function rooted(prefix, url) {
    var u = String(url == null ? "" : url);
    if (!prefix || !u || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u)) return u;
    return prefix + u;
  }

  root.HC_CORE = { STOP_WORDS: STOP_WORDS, normalise: normalise, within1: within1, variants: variants, makeSearch: makeSearch, decodeHash: decodeHash, rooted: rooted };
})(typeof window !== "undefined" ? window : globalThis);

// ---------- 2. chrome ----------
(function () {
  if (typeof document === "undefined") return;
  var CORE = window.HC_CORE;
  var SITE = window.HC_SITE || {};
  var INDEX = window.HC_INDEX || [];
  var brand = SITE.brand || {};
  var nav = SITE.nav || [];
  var page = document.body.dataset.page || "";
  // An article page is not in the navigation: it lights up the grouped page that holds the article.
  var navPage = document.body.dataset.nav || page;
  var ROOT = document.body.dataset.root || "";
  function rooted(url) { return CORE.rooted(ROOT, url); }
  var isHome = page === "home";
  var NARROW = "(max-width:960px)";
  // A group longer than this is folded in the lists a phone shows, so the groups after it stay in reach.
  var FOLD_OVER = 6;
  var MAX_RESULTS = 8;
  var SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  var search = CORE.makeSearch(INDEX, (SITE.search || {}).synonyms);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function isNarrow() { return !!(window.matchMedia && window.matchMedia(NARROW).matches); }
  function chatOn() { return !!(SITE.chat && SITE.intercomAppId); }

  // ---- the list of topics, used by the sidebar and by the menu of the top bar
  function pageLink(item, subs) {
    var on = item[0] === navPage;
    var html = '<a href="' + esc(rooted(item[0] + ".html")) + '"' + (on ? ' class="on"' + (navPage === page ? ' aria-current="page"' : "") : "") + ">" + esc(item[1]) + "</a>";
    if (on && subs) buttons.forEach(function (b) {
      html += '<a class="sub" data-tab="' + esc(b.dataset.tab) + '" href="#' + esc(b.dataset.tab) + '">' + esc(b.textContent) + "</a>";
    });
    return html;
  }
  function topicsHtml(opts) {
    return nav.map(function (g) {
      var links = g.items.map(function (it) { return pageLink(it, opts.subs); }).join("");
      if (!opts.fold || g.items.length <= FOLD_OVER) return '<div class="side-group">' + esc(g.group) + "</div>" + links;
      return '<details class="side-fold"><summary class="side-group">' + esc(g.group) + " <span>" + g.items.length + " pages</span></summary>" + links + "</details>";
    }).join("");
  }

  // ---- top bar
  // The quick links are the first page of each sidebar group, unless the site declares its own.
  function topLinks() {
    if (SITE.topnav) return SITE.topnav;
    return nav.filter(function (g) { return g.items.length; }).slice(0, 4).map(function (g) {
      return [g.items[0][0] + ".html", g.group];
    });
  }
  var closeMenu = function () {};
  function buildTopbar() {
    var logo = brand.logo
      ? '<img src="' + esc(rooted(brand.logo)) + '" alt="' + esc(brand.name) + '" height="34">'
      : "<span>" + esc(brand.name) + "</span>";
    var links = topLinks().map(function (l) { return '<a href="' + esc(rooted(l[0])) + '">' + esc(l[1]) + "</a>"; }).join("");
    var cta = SITE.cta && SITE.cta.url
      ? '<a class="btn btn-gold" href="' + esc(SITE.cta.url) + '">' + esc(SITE.cta.label) + "</a>"
      : "";
    var top = document.createElement("header");
    top.className = "topbar";
    top.innerHTML = '<div class="topbar-in"><a class="brand" href="' + esc(rooted("index.html")) + '">' + logo + "<small>Help Center</small></a>" +
      '<nav class="topnav" aria-label="Main">' + links + "</nav>" +
      '<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="hc-menu">Menu</button>' + cta + "</div>" +
      '<nav class="menu-panel" id="hc-menu" aria-label="All topics" hidden>' + topicsHtml({ fold: true, subs: false }) + cta + "</nav>";
    document.body.prepend(top);
    var toggle = top.querySelector(".menu-toggle"), panel = top.querySelector(".menu-panel");
    function setMenu(open) {
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Close" : "Menu";
    }
    toggle.addEventListener("click", function () { setMenu(panel.hidden); });
    closeMenu = function () { if (!panel.hidden) { setMenu(false); toggle.focus(); } };
  }

  // ---- tabs
  var buttons = [].slice.call(document.querySelectorAll(".tabs button"));
  var updateToTop = function () {};
  function show(id, scroll) {
    var found = buttons.some(function (b) { return b.dataset.tab === id; });
    if (!found) return false;
    buttons.forEach(function (b) {
      var on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("on", p.dataset.panel === id); });
    document.querySelectorAll(".side a.sub").forEach(function (a) { a.classList.toggle("on", a.dataset.tab === id); });
    if (scroll) document.querySelector(".tabs").scrollIntoView({ block: "start", behavior: "instant" });
    updateToTop();
    return true;
  }
  function wireTabs() {
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        history.replaceState(null, "", "#" + b.dataset.tab);
        show(b.dataset.tab);
      });
    });
  }

  // ---- deep links: a tab key, or the id of anything inside a panel
  function fromHash() {
    var h = CORE.decodeHash(location.hash);
    if (!h) return;
    if (show(h, true)) return;
    var el = document.getElementById(h);
    if (!el) return;
    var panel = el.closest(".panel");
    if (panel) show(panel.dataset.panel);
    var acc = el.closest("details");
    if (acc) acc.open = true;
    // Instant: a smooth scroll started while the page is still laying out stops short of the target.
    el.scrollIntoView({ block: el.tagName === "DETAILS" ? "center" : "start", behavior: "instant" });
  }

  // ---- an opened question puts its own address in the bar, ready to be shared
  function wireAccordions() {
    document.querySelectorAll("details.acc[id]").forEach(function (d) {
      d.addEventListener("toggle", function () {
        if (!d.open) return;
        // A link to something inside the question keeps its more precise address.
        var target = document.getElementById(CORE.decodeHash(location.hash));
        if (target && target !== d && d.contains(target)) return;
        history.replaceState(null, "", "#" + d.id);
      });
    });
  }

  // ---- copy link: on every article and every section heading
  function selectUrl(button, url) {
    var field = button.nextElementSibling;
    if (!field || !field.classList.contains("copy-url")) {
      field = document.createElement("input");
      field.className = "copy-url";
      field.readOnly = true;
      field.setAttribute("aria-label", "Link to this section");
      button.after(field);
    }
    field.value = url;
    field.focus();
    field.select();
  }
  // Without an id the link is the page itself: on an article page, the article's own address.
  function copyLink(button, id, label) {
    var url = location.href.split("#")[0] + (id ? "#" + id : "");
    if (id) history.replaceState(null, "", "#" + id);
    function copied() {
      button.textContent = "Copied";
      button.setAttribute("aria-label", "Link copied");
      setTimeout(function () { button.textContent = "Copy link"; button.setAttribute("aria-label", label); }, 1600);
    }
    // Without the clipboard API (an old browser, a page not served over https) the link is shown, selected.
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(copied, function () { selectUrl(button, url); });
    else selectUrl(button, url);
  }
  function addCopyLinks() {
    document.querySelectorAll("main.article .sec[id], main.article details.acc[id], main.article h3[id]").forEach(function (el) {
      var isAcc = el.tagName === "DETAILS";
      var label = "Copy link to " + (isAcc ? el.querySelector("summary") : el).textContent.trim();
      var b = document.createElement("button");
      b.type = "button";
      b.className = "copy-link";
      b.setAttribute("aria-label", label);
      b.textContent = "Copy link";
      b.addEventListener("click", function () { copyLink(b, el.id, label); });
      (isAcc ? el.querySelector(".acc-body") || el : el).appendChild(b);
    });
  }

  function addPageCopyLink() {
    var slot = document.querySelector("main.article [data-copy-page]");
    if (!slot) return;
    var label = "Copy link to this article";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "copy-link";
    b.setAttribute("aria-label", label);
    b.textContent = "Copy link";
    b.addEventListener("click", function () { copyLink(b, "", label); });
    slot.appendChild(b);
  }

  // ---- back to top, only where there is a way back to make
  function wireToTop() {
    var row = document.querySelector(".to-top");
    if (!row) return;
    row.querySelector("a").addEventListener("click", function (e) {
      // The hash stays on the open tab or article.
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "instant" });
      // Keyboard and screen reader users land on the title, not on the link they just left.
      var title = document.querySelector("main.article h1");
      if (title) { title.setAttribute("tabindex", "-1"); title.focus({ preventScroll: true }); }
    });
    var main = document.querySelector("main.article");
    // Long = the article itself (the open tab), not the footer under it.
    updateToTop = function () {
      row.hidden = true;
      row.hidden = main.getBoundingClientRect().height < window.innerHeight * 1.5;
    };
    window.addEventListener("resize", updateToTop);
    window.addEventListener("load", updateToTop);
    updateToTop();
  }

  // ---- search
  function supportOptions() {
    var out = [];
    if (SITE.supportEmail) out.push('<a href="mailto:' + esc(SITE.supportEmail) + '">Email ' + esc(SITE.supportEmail) + "</a>");
    if (chatOn()) out.push('<button type="button" data-open-chat>Open live chat</button>');
    return out.length ? '<div class="no-results-options">' + out.join("") + "</div>" : "";
  }
  function resultsHtml(query) {
    var hits = search(query, MAX_RESULTS);
    if (!hits.length) return '<div class="no-results"><p>No results for <strong>' + esc(query) + "</strong></p>" + supportOptions() + "</div>";
    // The index is written relative to the site root: the prefix is added here, when a result is drawn.
    return hits.map(function (x) { return '<a href="' + esc(rooted(x[1])) + '"><small>' + esc(x[2]) + "</small>" + esc(x[0]) + "</a>"; }).join("");
  }
  var searchBoxes = [];
  function closeResults() {
    searchBoxes.forEach(function (s) { s.box.style.display = "none"; });
  }
  function wireSearch(root) {
    var input = root.querySelector("input"), box = root.nextElementSibling;
    searchBoxes.push({ input: input, box: box });
    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 2) { box.style.display = "none"; return; }
      box.innerHTML = resultsHtml(q);
      box.style.display = "block";
    });
    // A result on the current page only changes the hash: close the list so the target is visible.
    box.addEventListener("click", function (e) { if (e.target.closest("a")) box.style.display = "none"; });
  }
  var searchHtml = '<div class="search">' + SEARCH_SVG +
    '<input type="search" placeholder="Search the help center..." aria-label="Search the help center"></div><div class="results" aria-live="polite"></div>';

  // ---- sidebar (article pages)
  function buildSidebar() {
    var main = document.querySelector("main.article");
    if (!main || isHome) return;
    var wrap = document.createElement("div");
    wrap.className = "wrap";
    main.parentNode.insertBefore(wrap, main);
    wrap.appendChild(main);
    var side = document.createElement("aside");
    side.className = "side";
    side.innerHTML = searchHtml +
      '<button class="side-toggle" type="button" aria-expanded="false" aria-controls="hc-topics">Browse all topics</button>' +
      '<nav class="side-nav" id="hc-topics" aria-label="Topics">' + topicsHtml({ fold: isNarrow(), subs: true }) + "</nav>";
    wrap.appendChild(side);
    var toggle = side.querySelector(".side-toggle");
    toggle.addEventListener("click", function () {
      var open = side.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Hide topics" : "Browse all topics";
    });
    wireSearch(side.querySelector(".search"));
  }
  function buildHeroSearch() {
    var hero = document.querySelector("[data-hero-search]");
    if (!hero) return;
    hero.innerHTML = searchHtml;
    wireSearch(hero.querySelector(".search"));
  }

  // ---- footer
  function buildFooter() {
    var cards = [];
    if (chatOn()) cards.push('<a class="card" href="#need-help" data-open-chat><div class="eyebrow">Fastest</div><h3>Live chat</h3><p>Open the chat and talk to the support team.</p></a>');
    if (SITE.supportEmail) cards.push('<a class="card" href="mailto:' + esc(SITE.supportEmail) + '"><div class="eyebrow">Email</div><h3>' + esc(SITE.supportEmail) + "</h3><p>For anything that needs documents or a longer explanation.</p></a>");
    if (SITE.dashboardUrl) cards.push('<a class="card" href="' + esc(SITE.dashboardUrl) + '"><div class="eyebrow">Dashboard</div><h3>Account dashboard</h3><p>Open your dashboard to manage your accounts.</p></a>');
    var foot = document.createElement("footer");
    var help = cards.length
      ? '<div class="help" id="need-help"><div class="help-in"><div class="eyebrow">Support</div><h2>Still need help?</h2><div class="grid g' + Math.max(cards.length, 2) + '">' + cards.join("") + "</div></div></div>"
      : "";
    foot.innerHTML = help + '<div class="foot">' + esc(brand.name) + " Help Center</div>";
    document.body.appendChild(foot);
  }
  // Every "open the chat" control, wherever it was drawn (footer card, empty search).
  function wireChatLinks() {
    document.addEventListener("click", function (e) {
      var opener = e.target.closest && e.target.closest("[data-open-chat]");
      if (!opener) return;
      e.preventDefault();
      if (typeof window.Intercom === "function") window.Intercom("show");
    });
  }

  // ---- Intercom messenger: only on a real host, never on a local preview or a file opened from disk
  function loadChat() {
    if (!chatOn()) return;
    if (!/^https?:$/.test(location.protocol)) return;
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    var appId = SITE.intercomAppId;
    window.intercomSettings = { api_base: "https://api-iam.intercom.io", app_id: appId };
    var w = window, ic = w.Intercom;
    if (typeof ic === "function") { ic("reattach_activator"); ic("update", w.intercomSettings); return; }
    var i = function () { i.c(arguments); };
    i.q = [];
    i.c = function (args) { i.q.push(args); };
    w.Intercom = i;
    var load = function () {
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://widget.intercom.io/widget/" + encodeURIComponent(appId);
      document.head.appendChild(s);
    };
    if (document.readyState === "complete") load(); else w.addEventListener("load", load, false);
  }

  // ---- keyboard: "/" focuses search, Escape closes the results and the menu
  function wireKeys() {
    document.addEventListener("keydown", function (e) {
      var t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && searchBoxes.length) {
        e.preventDefault();
        searchBoxes[0].input.focus();
      } else if (e.key === "Escape") {
        closeResults();
        closeMenu();
        if (typing && t.type === "search") t.blur();
      }
    });
  }

  buildTopbar();
  wireTabs();
  buildSidebar();
  buildHeroSearch();
  buildFooter();
  wireChatLinks();
  wireKeys();
  loadChat();
  addCopyLinks();
  addPageCopyLink();
  wireAccordions();
  wireToTop();
  window.addEventListener("hashchange", fromHash);
  if (buttons.length && !document.querySelector(".tabs button.on")) show(buttons[0].dataset.tab);
  else if (buttons.length) show(document.querySelector(".tabs button.on").dataset.tab);
  fromHash();
})();
