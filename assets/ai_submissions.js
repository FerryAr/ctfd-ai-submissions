(function () {
  "use strict";

  var ALLOWED_EXTENSIONS = [".py", ".sh", ".txt"];

  function isValidAiUrl(value) {
    try {
      var u = new URL(value);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      var host = u.hostname.toLowerCase();
      // ChatGPT: chatgpt.com/share/... or chat.openai.com/share/...
      if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
        return u.pathname.startsWith("/share/");
      }
      // Gemini: gemini.google.com/share/...
      if (host === "gemini.google.com") {
        return u.pathname.startsWith("/share/");
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function isValidExtension(filename) {
    if (!filename) return false;
    var lower = filename.toLowerCase();
    for (var i = 0; i < ALLOWED_EXTENSIONS.length; i++) {
      if (lower.endsWith(ALLOWED_EXTENSIONS[i])) {
        return true;
      }
    }
    return false;
  }

  function showAlert(message) {
    if (window.CTFd && CTFd.ui && CTFd.ui.ezq && typeof CTFd.ui.ezq.ezAlert === "function") {
      CTFd.ui.ezq.ezAlert({ title: "Validasi Gagal", body: message, button: "Mengerti" });
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

    var gridRow = modal.querySelector(".ai-solver-grid");
    if (!gridRow) {
      gridRow = document.createElement("div");
      gridRow.className = "row g-3 mb-3 ai-solver-grid";
      gridRow.innerHTML = 
        '<div class="col-12 col-md-6 ai-link-col">' +
          '<label class="form-label small fw-semibold" for="challenge-ai-link" style="color: #1d1d1f; display: flex; align-items: center; gap: 4px; margin-bottom: 6px;">' +
            '<i class="fas fa-robot text-success me-1"></i>' +
            '<span>AI Link (ChatGPT / Gemini Free)</span>' +
            '<span style="color: #ef4444; font-weight: bold;">*</span>' +
          '</label>' +
          '<input class="form-control rounded-3 py-2 px-3" type="url" id="challenge-ai-link" name="ai_link" ' +
            'placeholder="https://chatgpt.com/share/... atau https://gemini.google.com/share/..." autocomplete="off" ' +
            'style="font-size: 13.5px; border-radius: 12px; background: rgba(0, 0, 0, 0.035); border: 1px solid rgba(0, 0, 0, 0.12);">' +
          '<small class="form-text text-muted" style="font-size: 11px; color: #86868b; display: block; margin-top: 4px;">' +
            'Wajib link share percakapan resmi ChatGPT atau Gemini Free.' +
          '</small>' +
        '</div>' +
        '<div class="col-12 col-md-6 solver-file-col">' +
          '<label class="form-label small fw-semibold" for="challenge-solver-file" style="color: #1d1d1f; display: flex; align-items: center; gap: 4px; margin-bottom: 6px;">' +
            '<i class="fas fa-file-code text-primary me-1"></i>' +
            '<span>File Solver (.py, .sh, .txt)</span>' +
            '<span style="color: #ef4444; font-weight: bold;">*</span>' +
          '</label>' +
          '<input class="form-control rounded-3 py-2 px-3" type="file" id="challenge-solver-file" name="solver_file" ' +
            'accept=".py,.sh,.txt" ' +
            'style="font-size: 13.5px; border-radius: 12px; background: rgba(0, 0, 0, 0.035); border: 1px solid rgba(0, 0, 0, 0.12);">' +
          '<small class="form-text text-muted" style="font-size: 11px; color: #86868b; display: block; margin-top: 4px;">' +
            'Hanya format .py, .sh, atau .txt (maksimal 5MB).' +
          '</small>' +
        '</div>';
      submitRow.parentNode.insertBefore(gridRow, submitRow);
    }
  }

  // Collect & Upload Metadata before submitting attempt
  async function prepareSubmissionMetadata() {
    var aiInput = document.querySelector("#challenge-ai-link");
    var ai_link = aiInput ? String(aiInput.value || "").trim() : "";

    if (ai_link === "") {
      showAlert("Link percakapan AI wajib diisi sebelum submit flag.");
      return null;
    }

    if (!isValidAiUrl(ai_link)) {
      showAlert("Link AI tidak valid! Hanya diperbolehkan link share resmi dari ChatGPT (chatgpt.com/share/...) atau Gemini (gemini.google.com/share/...).");
      return null;
    }

    var fileInput = document.querySelector("#challenge-solver-file");
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      showAlert("File solver wajib diunggah sebelum submit flag.");
      return null;
    }

    var solverFile = fileInput.files[0];
    if (!isValidExtension(solverFile.name)) {
      showAlert("Format file solver ditolak! Hanya file berekstensi .py, .sh, atau .txt yang diperbolehkan.");
      return null;
    }

    if (solverFile.size > 5 * 1024 * 1024) {
      showAlert("Ukuran file solver melebihi batas 5MB.");
      return null;
    }

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
        return null;
      }

      return {
        ai_link: ai_link,
        solver_file: uploadData.stored_filename,
        solver_name: uploadData.original_filename
      };
    } catch (err) {
      showAlert("Terjadi kesalahan jaringan saat mengunggah file solver.");
      return null;
    }
  }

  // Intercept via window.fetch to catch ALL requests to /api/v1/challenges/attempt
  var origFetch = window.fetch;
  window.fetch = async function (resource, options) {
    var url = typeof resource === "string" ? resource : (resource && resource.url ? resource.url : "");

    if (url.indexOf("/api/v1/challenges/attempt") !== -1 && options && options.method === "POST") {
      // Check if preview
      if (url.indexOf("preview=true") === -1) {
        var metadata = await prepareSubmissionMetadata();
        if (!metadata) {
          // Return simulated 200 response with data.status="incorrect" so theme doesn't crash!
          return new Response(JSON.stringify({
            success: true,
            data: {
              status: "incorrect",
              message: "Silakan lengkapi link AI dan file solver."
            }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Attach metadata to JSON payload
        try {
          var payload = typeof options.body === "string" ? JSON.parse(options.body) : {};
          payload.ai_link = metadata.ai_link;
          payload.solver_file = metadata.solver_file;
          payload.solver_name = metadata.solver_name;
          options.body = JSON.stringify(payload);
        } catch (e) {
          console.error("Failed to inject AI metadata into attempt body", e);
        }
      }
    }

    return origFetch.call(this, resource, options);
  };

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
