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

  function ensureInputs() {
    var modal = document.querySelector("#challenge-window");
    if (!modal) return;

    if (document.querySelector("#challenge-ai-link") && document.querySelector("#challenge-solver-file")) {
      return;
    }

    var submitRow = modal.querySelector(".submit-row");
    if (!submitRow) return;

    // AI Link Container
    if (!document.querySelector("#challenge-ai-link")) {
      var aiContainer = document.createElement("div");
      aiContainer.className = "mb-3 ai-link-row";
      aiContainer.innerHTML = 
        '<label class="form-label small fw-semibold" for="challenge-ai-link" style="color: #1d1d1f; display: flex; align-items: center; gap: 4px;">' +
          '<i class="fas fa-robot text-success me-1"></i>' +
          '<span>AI Conversation Link</span>' +
          '<span style="color: #ef4444; font-weight: bold;">*</span>' +
        '</label>' +
        '<input class="form-control rounded-3 py-2 px-3" type="url" id="challenge-ai-link" name="ai_link" ' +
          'placeholder="https://chatgpt.com/share/... atau https://claude.ai/share/..." autocomplete="off" ' +
          'style="font-size: 13.5px; border-radius: 12px; background: rgba(0, 0, 0, 0.035); border: 1px solid rgba(0, 0, 0, 0.12);">' +
        '<small class="form-text text-muted" style="font-size: 11.5px; color: #86868b; display: block; margin-top: 4px;">' +
          'Wajib melampirkan link share percakapan AI resmi (ChatGPT / Claude / Gemini).' +
        '</small>';
      submitRow.parentNode.insertBefore(aiContainer, submitRow);
    }

    // Solver File Container
    if (!document.querySelector("#challenge-solver-file")) {
      var fileContainer = document.createElement("div");
      fileContainer.className = "mb-3 solver-file-row";
      fileContainer.innerHTML = 
        '<label class="form-label small fw-semibold" for="challenge-solver-file" style="color: #1d1d1f; display: flex; align-items: center; gap: 4px;">' +
          '<i class="fas fa-file-code text-primary me-1"></i>' +
          '<span>File Solver / Script Exploit</span>' +
          '<span style="color: #ef4444; font-weight: bold;">*</span>' +
        '</label>' +
        '<input class="form-control rounded-3 py-2 px-3" type="file" id="challenge-solver-file" name="solver_file" ' +
          'accept=".py,.sh,.txt,.c,.cpp,.java,.go,.rb,.rs,.zip" ' +
          'style="font-size: 13.5px; border-radius: 12px; background: rgba(0, 0, 0, 0.035); border: 1px solid rgba(0, 0, 0, 0.12);">' +
        '<small class="form-text text-muted" style="font-size: 11.5px; color: #86868b; display: block; margin-top: 4px;">' +
          'Unggah file solver/script exploit kamu (.py, .sh, .txt, .zip, maks 5MB).' +
        '</small>';
      submitRow.parentNode.insertBefore(fileContainer, submitRow);
    }
  }

  // Intercept CTFd.api.post_challenge_attempt
  function setupApiInterceptor() {
    if (!window.CTFd || !window.CTFd.api || typeof window.CTFd.api.post_challenge_attempt !== "function") {
      setTimeout(setupApiInterceptor, 100);
      return;
    }

    var original = window.CTFd.api.post_challenge_attempt;
    window.CTFd.api.post_challenge_attempt = async function (parameters, body) {
      if (parameters && parameters.preview) {
        return original.call(this, parameters, body);
      }

      var aiInput = document.querySelector("#challenge-ai-link");
      var ai_link = aiInput ? String(aiInput.value || "").trim() : "";

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

      var fileInput = document.querySelector("#challenge-solver-file");
      if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showAlert("File solver / script exploit wajib diunggah sebelum submit flag.");
        return Promise.resolve({
          success: true,
          data: { status: "unknown", message: "" },
        });
      }

      var solverFile = fileInput.files[0];
      if (solverFile.size > 5 * 1024 * 1024) {
        showAlert("Ukuran file solver melebihi batas 5MB.");
        return Promise.resolve({
          success: true,
          data: { status: "unknown", message: "" },
        });
      }

      // Upload solver file first
      var formData = new FormData();
      formData.append("solver_file", solverFile);

      try {
        var uploadRes = await fetch("/api/v1/plugins/ai_submissions/upload-solver", {
          method: "POST",
          headers: {
            "CSRF-Token": (window.init && window.init.csrfNonce) || ""
          },
          body: formData
        });

        var uploadData = await uploadRes.json();
        if (!uploadRes.ok || !uploadData.success) {
          showAlert("Gagal mengunggah file solver: " + (uploadData.error || "Server error"));
          return Promise.resolve({
            success: true,
            data: { status: "unknown", message: "" },
          });
        }

        body = body || {};
        body.ai_link = ai_link;
        body.solver_file = uploadData.stored_filename;
        body.solver_name = uploadData.original_filename;

        return original.call(this, parameters, body);
      } catch (err) {
        showAlert("Terjadi kesalahan jaringan saat mengunggah file solver.");
        return Promise.resolve({
          success: true,
          data: { status: "unknown", message: "" },
        });
      }
    };
  }

  setupApiInterceptor();

  // Watch for modal events
  document.addEventListener("shown.bs.modal", function (e) {
    if (e.target && e.target.id === "challenge-window") {
      ensureInputs();
    }
  });

  var observer = new MutationObserver(function () {
    var modal = document.querySelector("#challenge-window");
    if (modal && modal.classList.contains("show")) {
      ensureInputs();
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.querySelector("#challenge-window");
    if (modal) {
      observer.observe(modal, { childList: true, subtree: true, attributes: true });
    }
  });
})();
