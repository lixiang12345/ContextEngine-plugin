/* ContextEngine 网站交互 — 零依赖 */
(function () {
  "use strict";

  /* JS 可用标记:reveal 动画只在有 JS 时启用(无 JS 内容保持可见) */
  var root = document.documentElement;
  root.classList.add("js");

  /* ---------- 主题切换 ---------- */
  function syncThemeColor(theme) {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", theme === "light" ? "#fafaf6" : "#0a0a0b");
  }
  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    syncThemeColor(theme);
    try { localStorage.setItem("ce-theme", theme); } catch (e) { /* 忽略隐私模式 */ }
  }
  syncThemeColor(root.getAttribute("data-theme"));
  document.querySelectorAll(".theme-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
    });
  });

  /* ---------- 移动端菜单 ---------- */
  var menuBtn = document.querySelector(".menu-btn");
  var mobileNav = document.querySelector(".mobile-nav");
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener("click", function () {
      var open = mobileNav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    mobileNav.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        mobileNav.classList.remove("open");
        menuBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- 文档目录（移动端折叠） ---------- */
  var tocToggle = document.querySelector(".docs-toc-toggle");
  var sidebar = document.querySelector(".docs-sidebar");
  if (tocToggle && sidebar) {
    tocToggle.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      tocToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest("a") && window.matchMedia("(max-width: 880px)").matches) {
        sidebar.classList.remove("open");
        tocToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- 微型语法高亮 ---------- */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  var BASH_CMDS = new RegExp(
    "^(\\s*)(npx|npm|node|git|docker|claude|contextengine(?:-mcp|-http)?|cd|export|curl|python3|openssl|ssh)\\b"
  );
  function hlBash(code) {
    return code.split("\n").map(function (line) {
      if (/^\s*#/.test(line)) return '<span class="tok-cmt">' + esc(line) + "</span>";
      var out = esc(line);
      // 字符串
      out = out.replace(/("[^"]*"|'[^']*')/g, '<span class="tok-str">$1</span>');
      // 环境变量
      out = out.replace(/(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/g, '<span class="tok-var">$1</span>');
      // 长短参数（避免命中 token 内部的连字符）
      out = out.replace(/(^|\s)(--?[A-Za-z][A-Za-z0-9-]*)/g, '$1<span class="tok-flag">$2</span>');
      // 行首命令词
      out = out.replace(BASH_CMDS, '$1<span class="tok-kw">$2</span>');
      // 行内注释（简化：空格 + # 之后）
      out = out.replace(/(\s)(#(?![^<]*&gt;)[^<]*)$/, '$1<span class="tok-cmt">$2</span>');
      return out;
    }).join("\n");
  }
  function hlTs(code) {
    var out = esc(code);
    var parts = out.split(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|`[^`]*`)/g);
    return parts.map(function (p) {
      if (!p) return "";
      if (/^\/\//.test(p) || /^\/\*/.test(p)) return '<span class="tok-cmt">' + p + "</span>";
      if (/^["'`]/.test(p)) return '<span class="tok-str">' + p + "</span>";
      return p
        .replace(/\b(import|from|export|const|let|var|await|async|function|return|new|type|interface|of|if|else|for|while|try|catch|throw)\b/g, '<span class="tok-kw">$1</span>')
        .replace(/\b(true|false|null|undefined)\b/g, '<span class="tok-num">$1</span>')
        .replace(/\b(\d[\d_]*(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>')
        .replace(/\b([A-Za-z_$][\w$]*)(?=\()/g, '<span class="tok-fn">$1</span>');
    }).join("");
  }
  function hlJson(code) {
    var out = esc(code);
    return out
      .replace(/("[^"]*")(\s*:)/g, '<span class="tok-kw">$1</span>$2')
      .replace(/(:\s*)("[^"]*")/g, '$1<span class="tok-str">$2</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-num">$1</span>')
      .replace(/(:\s*)(-?\d[\d.]*)/g, '$1<span class="tok-num">$2</span>');
  }
  document.querySelectorAll(".codeblock pre > code").forEach(function (el) {
    var lang = (el.getAttribute("data-lang") || "").toLowerCase();
    var raw = el.textContent;
    if (lang === "bash" || lang === "sh") el.innerHTML = hlBash(raw);
    else if (lang === "ts" || lang === "js" || lang === "typescript") el.innerHTML = hlTs(raw);
    else if (lang === "json") el.innerHTML = hlJson(raw);
  });

  /* ---------- 代码复制按钮 ---------- */
  var COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var OK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  document.querySelectorAll(".codeblock").forEach(function (block) {
    var pre = block.querySelector("pre");
    if (!pre) return;
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "复制代码");
    btn.innerHTML = COPY_SVG;
    btn.addEventListener("click", function () {
      var text = pre.innerText.replace(/\n$/, "");
      function done() {
        btn.classList.add("copied");
        btn.innerHTML = OK_SVG;
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.innerHTML = COPY_SVG;
        }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta);
        done();
      }
    });
    block.appendChild(btn);
  });

  /* ---------- 文档 scrollspy ---------- */
  var spyLinks = document.querySelectorAll(".docs-sidebar a[href^='#']");
  if (spyLinks.length) {
    var map = {};
    var sections = [];
    spyLinks.forEach(function (a) {
      var id = a.getAttribute("href").slice(1);
      var sec = document.getElementById(id);
      if (sec) { map[id] = a; sections.push(sec); }
    });
    var current = null;
    function setActive(id) {
      if (current === id) return;
      current = id;
      spyLinks.forEach(function (a) { a.classList.remove("active"); });
      if (map[id]) map[id].classList.add("active");
    }
    function onScroll() {
      var offset = 120;
      var active = sections.length ? sections[0].id : null;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= offset) active = sections[i].id;
        else break;
      }
      // 页面滚到底时强制选中最后一节
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
        active = sections[sections.length - 1].id;
      }
      if (active) setActive(active);
    }
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () { onScroll(); ticking = false; });
      }
    }, { passive: true });
    onScroll();
  }

  /* ---------- 标题锚点 ---------- */
  document.querySelectorAll(".docs-main section[id] > h2").forEach(function (h) {
    var id = h.parentElement.id;
    var a = document.createElement("a");
    a.className = "anchor-link";
    a.href = "#" + id;
    a.textContent = "#";
    a.setAttribute("aria-label", "本节链接");
    h.appendChild(a);
  });

  /* ---------- 滚动入场(同步几何检测,不依赖 IntersectionObserver) ---------- */
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (reduce || !revealEls.length) {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  } else {
    function checkReveal() {
      if (!revealEls.length) return;
      var vh = document.documentElement.clientHeight || window.innerHeight;
      revealEls = revealEls.filter(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < vh * 0.92 && r.bottom > 0) {
          el.classList.add("in");
          return false;
        }
        return true;
      });
    }
    var revealTick = false;
    function onRevealScroll() {
      if (revealTick) return;
      revealTick = true;
      requestAnimationFrame(function () { checkReveal(); revealTick = false; });
    }
    window.addEventListener("scroll", onRevealScroll, { passive: true });
    window.addEventListener("resize", onRevealScroll);
    checkReveal();
    /* 最终保险:3 秒后未入场的元素全部显示(scroll 事件异常的环境也不丢内容) */
    setTimeout(function () {
      revealEls.forEach(function (el) { el.classList.add("in"); });
      revealEls = [];
    }, 3000);
  }
})();
