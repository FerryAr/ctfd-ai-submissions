(function () {
  "use strict";

  var ALLOWED_EXTENSIONS = [".py", ".sh", ".txt"];

  function isValidAiUrl(value) {
    try {
      var u = new URL(value);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      var host = u.hostname.toLowerCase();
      var path = u.pathname;

      // ChatGPT: chatgpt.com/share/... or chat.openai.com/share/...
      if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
        return path.startsWith("/share/");
      }

      // Gemini: share.gemini.google/<id> or gemini.google.com/share/...
      if (host === "share.gemini.google" && path.length > 1) {
        return true;
      }
      if (host === "gemini.google.com" && path.startsWith("/share/")) {
        return true;
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

  function getAiInputElement() {
    var inputs = document.querySelectorAll("#challenge-ai-link, input[name='ai_link']");
    for (var i = inputs.length - 1; i >= 0; i--) {
      if (inputs[i].value && inputs[i].value.trim() !== "") {
        return inputs[i];
      }
    }
    return inputs[inputs.length - 1] || null;
  }

  function getSolverInputElement() {
    var inputs = document.querySelectorAll("#challenge-solver-file, input[name='solver_file']");
    for (var i = inputs.length - 1; i >= 0; i--) {
      if (inputs[i].files && inputs[i].files.length > 0) {
        return inputs[i];
      }
    }
    return inputs[inputs.length - 1] || null;
  }

  async function prepareSubmissionMetadata() {
    var aiInput = getAiInputElement();
    var ai_link = aiInput ? String(aiInput.value || "").trim() : "";

    if (ai_link === "") {
      showAlert("Link percakapan AI wajib diisi sebelum submit flag.");
      return null;
    }

    if (!isValidAiUrl(ai_link)) {
      showAlert("Link AI tidak valid! Hanya diperbolehkan link share resmi dari ChatGPT (chatgpt.com/share/...) atau Gemini (share.gemini.google/...).");
      return null;
    }

    var fileInput = getSolverInputElement();
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

  // Intercept via window.fetch
  var origFetch = window.fetch;
  window.fetch = async function (resource, options) {
    var url = typeof resource === "string" ? resource : (resource && resource.url ? resource.url : "");

    if (url.indexOf("/api/v1/challenges/attempt") !== -1 && options && options.method === "POST") {
      if (url.indexOf("preview=true") === -1) {
        var metadata = await prepareSubmissionMetadata();
        if (!metadata) {
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
})();
