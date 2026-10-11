(function () {
  "use strict";

  function isValidHttpUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function showAlert(message) {
    if (window.CTFd && CTFd.ui && CTFd.ui.ezq && typeof CTFd.ui.ezq.ezAlert === "function") {
      CTFd.ui.ezq.ezAlert({ title: "Perhatian", body: message, button: "OK" });
    } else {
      window.alert(message);
    }
  }

  function ensureAiLinkRow() {
    var modal = document.querySelector("#challenge-window");
    if (!modal) return;

    if (document.querySelector("#challenge-ai-link")) return;

    var submitRow = modal.querySelector(".submit-row");
    if (!submitRow) return;

    var container = document.createElement("div");
    container.className = "mb-3 ai-link-row";
    container.innerHTML = 
      '<label class="form-label small fw-semibold" for="challenge-ai-link" style="color: #1d1d1f; display: flex; align-items: center; gap: 4px;">' +
        '<span>AI Conversation Link</span>' +
        '<span style="color: #ef4444; font-weight: bold;">*</span>' +
      '</label>' +
      '<input class="form-control rounded-3 py-2 px-3" type="url" id="challenge-ai-link" name="ai_link" ' +
        'placeholder="https://chatgpt.com/share/... atau https://claude.ai/share/..." autocomplete="off" ' +
        'style="font-size: 13.5px; border-radius: 12px; background: rgba(0, 0, 0, 0.035); border: 1px solid rgba(0, 0, 0, 0.12);">' +
      '<small class="form-text text-muted" style="font-size: 11.5px; color: #86868b; display: block; margin-top: 4px;">' +
        'Wajib melampirkan link percakapan AI resmi (ChatGPT / Claude / Gemini).' +
      '</small>';

    submitRow.parentNode.insertBefore(container, submitRow);
  }

  // Intercept CTFd.api.post_challenge_attempt
  function setupApiInterceptor() {
    if (!window.CTFd || !window.CTFd.api || typeof window.CTFd.api.post_challenge_attempt !== "function") {
      setTimeout(setupApiInterceptor, 100);
      return;
    }

    var original = window.CTFd.api.post_challenge_attempt;
    window.CTFd.api.post_challenge_attempt = function (parameters, body) {
      if (parameters && parameters.preview) {
        return original.call(this, parameters, body);
      }

      var input = document.querySelector("#challenge-ai-link");
      var ai_link = input ? String(input.value || "").trim() : "";

      if (ai_link === "") {
        showAlert("Link percakapan AI wajib diisi sebelum submit flag.");
        return Promise.resolve({
          success: true,
          data: { status: "unknown", message: "" },
        });
      }

      if (!isValidHttpUrl(ai_link)) {
        showAlert("Link percakapan AI harus berupa URL yang valid (http:// atau https://).");
        return Promise.resolve({
          success: true,
          data: { status: "unknown", message: "" },
        });
      }

      body = body || {};
      body.ai_link = ai_link;

      return original.call(this, parameters, body);
    };
  }

  setupApiInterceptor();

  // Watch for modal display via Bootstrap events or MutationObserver
  document.addEventListener("shown.bs.modal", function (e) {
    if (e.target && e.target.id === "challenge-window") {
      ensureAiLinkRow();
    }
  });

  // Backup watcher: observer when challenge-window gets content
  var observer = new MutationObserver(function () {
    var modal = document.querySelector("#challenge-window");
    if (modal && modal.classList.contains("show")) {
      ensureAiLinkRow();
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.querySelector("#challenge-window");
    if (modal) {
      observer.observe(modal, { childList: true, subtree: true, attributes: true });
    }
  });
})();
