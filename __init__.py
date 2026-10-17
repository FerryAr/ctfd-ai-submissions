import datetime
import os
import re
from urllib.parse import urlparse

from flask import (
    Blueprint,
    current_app,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from CTFd.exceptions.challenges import ChallengeSolveException
from CTFd.models import (
    Challenges,
    Fails,
    Partials,
    Ratelimiteds,
    Solves,
    Submissions,
    db,
)
from CTFd.plugins import (
    register_admin_plugin_menu_bar,
    register_admin_plugin_script,
    register_plugin_assets_directory,
    register_plugin_script,
)
from CTFd.plugins.challenges import (
    CHALLENGE_CLASSES,
    CTFdStandardChallenge,
    calculate_value,
)
from CTFd.plugins.challenges.decay import DECAY_FUNCTIONS
from CTFd.plugins.dynamic_challenges import DynamicValueChallenge
from CTFd.utils.decorators import admins_only, authed_only
from CTFd.utils.user import authed, get_current_user, get_ip, is_admin

class AiLinks(db.Model):
    __tablename__ = "ai_links"

    id = db.Column(db.Integer, primary_key=True)
    submission_id = db.Column(
        db.Integer, db.ForeignKey("submissions.id", ondelete="CASCADE")
    )
    value = db.Column(db.Text)
    solver_file = db.Column(db.String(255), nullable=True)
    solver_name = db.Column(db.String(255), nullable=True)
    date = db.Column(db.DateTime, default=datetime.datetime.utcnow)

    submission = db.relationship("Submissions", foreign_keys=[submission_id])


class AiSubmissionStandardChallenge(CTFdStandardChallenge):
    id = "standard"
    name = "standard"

    @staticmethod
    def _get_metadata(request):
        request_data = request.form if not request.is_json else (request.get_json() or {})
        ai_link = (request_data.get("ai_link") or "").strip()
        solver_file = (request_data.get("solver_file") or "").strip() or None
        solver_name = (request_data.get("solver_name") or "").strip() or None
        return ai_link, solver_file, solver_name

    @classmethod
    def partial(cls, user, team, challenge, request):
        data = request.form or request.get_json()
        submission = data["submission"].strip()
        ai_link, solver_file, solver_name = cls._get_metadata(request)

        partial = Partials(
            user_id=user.id,
            team_id=team.id if team else None,
            challenge_id=challenge.id,
            ip=get_ip(req=request),
            provided=submission,
        )
        db.session.add(partial)
        db.session.flush()
        db.session.add(
            AiLinks(
                submission_id=partial.id,
                value=ai_link,
                solver_file=solver_file,
                solver_name=solver_name,
            )
        )
        db.session.commit()

    @classmethod
    def ratelimited(cls, user, team, challenge, request):
        data = request.form or request.get_json()
        submission = data["submission"].strip()
        ai_link, solver_file, solver_name = cls._get_metadata(request)

        ratelimited = Ratelimiteds(
            user_id=user.id,
            team_id=team.id if team else None,
            challenge_id=challenge.id,
            ip=get_ip(req=request),
            provided=submission,
        )
        db.session.add(ratelimited)
        db.session.flush()
        db.session.add(
            AiLinks(
                submission_id=ratelimited.id,
                value=ai_link,
                solver_file=solver_file,
                solver_name=solver_name,
            )
        )
        db.session.commit()

    @classmethod
    def solve(cls, user, team, challenge, request):
        data = request.form or request.get_json()
        submission = data["submission"].strip()
        ai_link, solver_file, solver_name = cls._get_metadata(request)

        solve = Solves(
            user_id=user.id,
            team_id=team.id if team else None,
            challenge_id=challenge.id,
            ip=get_ip(req=request),
            provided=submission,
        )

        try:
            db.session.add(solve)
            db.session.flush()
            db.session.add(
                AiLinks(
                    submission_id=solve.id,
                    value=ai_link,
                    solver_file=solver_file,
                    solver_name=solver_name,
                )
            )
            db.session.commit()
        except IntegrityError as e:
            db.session.rollback()
            raise ChallengeSolveException(
                f"Duplicate solve for user {user.id} on challenge {challenge.id}"
            ) from e

        if challenge.function in DECAY_FUNCTIONS:
            calculate_value(challenge)

    @classmethod
    def fail(cls, user, team, challenge, request):
        data = request.form or request.get_json()
        submission = data["submission"].strip()
        ai_link, solver_file, solver_name = cls._get_metadata(request)

        wrong = Fails(
            user_id=user.id,
            team_id=team.id if team else None,
            challenge_id=challenge.id,
            ip=get_ip(request),
            provided=submission,
        )
        db.session.add(wrong)
        db.session.flush()
        db.session.add(
            AiLinks(
                submission_id=wrong.id,
                value=ai_link,
                solver_file=solver_file,
                solver_name=solver_name,
            )
        )
        db.session.commit()


class AiSubmissionDynamicChallenge(DynamicValueChallenge, AiSubmissionStandardChallenge):
    id = "dynamic"
    name = "dynamic"


def patch_dynamic_iac():
    if "dynamic_iac" in CHALLENGE_CLASSES:
        cls = CHALLENGE_CLASSES["dynamic_iac"]
        if not getattr(cls, "_ai_link_patched", False):
            orig_solve = cls.solve

            @classmethod
            def solve_hook(c, user, team, challenge, request):
                try:
                    orig_solve(user, team, challenge, request)
                except Exception as e:
                    pass

                try:
                    ai_link, solver_file, solver_name = AiSubmissionStandardChallenge._get_metadata(request)
                    last_solve = Solves.query.filter_by(
                        user_id=user.id, challenge_id=challenge.id
                    ).order_by(Solves.id.desc()).first()
                    if last_solve and not AiLinks.query.filter_by(submission_id=last_solve.id).first():
                        db.session.add(
                            AiLinks(
                                submission_id=last_solve.id,
                                value=ai_link,
                                solver_file=solver_file,
                                solver_name=solver_name,
                            )
                        )
                        db.session.commit()
                except Exception:
                    db.session.rollback()

                # Safety guarantee: ensure instance is destroyed if destroy_on_flag is enabled
                try:
                    from CTFd.plugins.ctfd_chall_manager.models import DynamicIaCChallenge
                    from CTFd.plugins.ctfd_chall_manager.utils.instance_manager import delete_instance
                    from CTFd.utils.config import is_teams_mode

                    c_iac = DynamicIaCChallenge.query.filter_by(id=challenge.id).first()
                    if c_iac and getattr(c_iac, "destroy_on_flag", False):
                        source_id = user.id
                        if is_teams_mode() and team:
                            source_id = team.id
                        elif is_teams_mode() and getattr(user, "team_id", None):
                            source_id = user.team_id
                        if getattr(c_iac, "shared", False):
                            source_id = 0
                        delete_instance(challenge.id, source_id)
                except Exception:
                    pass

            cls.solve = solve_hook

            orig_fail = getattr(cls, "fail", None)
            if orig_fail:
                @classmethod
                def fail_hook(c, user, team, challenge, request):
                    orig_fail(user, team, challenge, request)
                    try:
                        ai_link, solver_file, solver_name = AiSubmissionStandardChallenge._get_metadata(request)
                        last_fail = Fails.query.filter_by(
                            user_id=user.id, challenge_id=challenge.id
                        ).order_by(Fails.id.desc()).first()
                        if last_fail and not AiLinks.query.filter_by(submission_id=last_fail.id).first():
                            db.session.add(
                                AiLinks(
                                    submission_id=last_fail.id,
                                    value=ai_link,
                                    solver_file=solver_file,
                                    solver_name=solver_name,
                                )
                            )
                            db.session.commit()
                    except Exception:
                        db.session.rollback()
                cls.fail = fail_hook

            cls._ai_link_patched = True


def validate_and_swap():
    if CHALLENGE_CLASSES.get("standard") is not AiSubmissionStandardChallenge:
        CHALLENGE_CLASSES["standard"] = AiSubmissionStandardChallenge
    if CHALLENGE_CLASSES.get("dynamic") is not AiSubmissionDynamicChallenge:
        CHALLENGE_CLASSES["dynamic"] = AiSubmissionDynamicChallenge
    patch_dynamic_iac()

    if request.method != "POST" or request.path != "/api/v1/challenges/attempt":
        return None

    if not authed():
        return None

    if is_admin() and request.args.get("preview"):
        return None

    request_data = request.form if not request.is_json else (request.get_json() or {})
    ai_link = (request_data.get("ai_link") or "").strip()
    solver_file = (request_data.get("solver_file") or "").strip()

    if not ai_link:
        return (
            jsonify(
                {
                    "success": True,
                    "data": {
                        "status": "incorrect",
                        "message": "Link percakapan AI wajib diisi sebelum submit flag!",
                    },
                }
            ),
            200,
        )

    parsed = urlparse(ai_link)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return (
            jsonify(
                {
                    "success": True,
                    "data": {
                        "status": "incorrect",
                        "message": "Link percakapan AI harus berupa URL yang valid (http/https).",
                    },
                }
            ),
            200,
        )

    # Restrict strictly to ChatGPT and Gemini Free share links
    host = parsed.netloc.lower()
    path = parsed.path
    is_chatgpt = (host in ("chatgpt.com", "www.chatgpt.com", "chat.openai.com") or host.endswith(".chatgpt.com")) and path.startswith("/share/")
    is_gemini = (host == "share.gemini.google" and len(path.strip("/")) > 0) or (host == "gemini.google.com" and path.startswith("/share/"))
    if not (is_chatgpt or is_gemini):
        return (
            jsonify(
                {
                    "success": True,
                    "data": {
                        "status": "incorrect",
                        "message": "Link AI tidak valid! Hanya diperbolehkan link share resmi dari ChatGPT (chatgpt.com/share/...) atau Gemini (gemini.google.com/share/...)",
                    },
                }
            ),
            200,
        )

    if not solver_file:
        return (
            jsonify(
                {
                    "success": True,
                    "data": {
                        "status": "incorrect",
                        "message": "File solver (.py, .sh, .txt) wajib diunggah sebelum submit flag!",
                    },
                }
            ),
            200,
        )

    return None


admin_ai_submissions = Blueprint(
    "admin_ai_submissions", __name__, template_folder="templates"
)


@admin_ai_submissions.route("/api/v1/plugins/ai_submissions/upload-solver", methods=["POST"])
@authed_only
def upload_solver_file():
    upload_solver_file._bypass_csrf = True
    if "solver_file" not in request.files:
        return jsonify({"success": False, "error": "Tidak ada file yang dipilih"}), 400

    file = request.files["solver_file"]
    if not file or not file.filename:
        return jsonify({"success": False, "error": "Nama file kosong"}), 400

    # Max 5MB backend validation
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    if file_size > 5 * 1024 * 1024:
        return jsonify({"success": False, "error": "Ukuran file melebihi batas 5MB"}), 400

    # Strict extension validation: .py, .sh, .txt only
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".py", ".sh", ".txt"):
        return jsonify({"success": False, "error": "Format file tidak diizinkan! Hanya diperbolehkan file .py, .sh, atau .txt"}), 400

    user = get_current_user()
    orig_filename = os.path.basename(file.filename)
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", orig_filename)
    ts = int(datetime.datetime.utcnow().timestamp())
    stored_filename = f"{ts}_{user.id}_{safe_name}"

    upload_dir = os.path.join(current_app.config.get("UPLOAD_FOLDER", "/var/uploads"), "solvers")
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, stored_filename)
    file.save(file_path)

    return jsonify({
        "success": True,
        "stored_filename": stored_filename,
        "original_filename": orig_filename,
    })


@admin_ai_submissions.route("/admin/ai-submissions/download-solver/<path:filename>")
@admins_only
def download_solver_file(filename):
    upload_dir = os.path.join(current_app.config.get("UPLOAD_FOLDER", "/var/uploads"), "solvers")
    return send_from_directory(upload_dir, filename, as_attachment=True)


@admin_ai_submissions.route("/admin/ai-submissions")
@admins_only
def admin_ai_submissions_listing():
    q = request.args.get("q")
    submission_type = request.args.get("type")
    page = abs(request.args.get("page", 1, type=int))

    filters = []
    if submission_type:
        filters.append(Submissions.type == submission_type)
    if q:
        filters.append(
            db.or_(
                AiLinks.value.ilike(f"%{q}%"),
                AiLinks.solver_name.ilike(f"%{q}%"),
                Submissions.provided.ilike(f"%{q}%"),
                Challenges.name.ilike(f"%{q}%"),
            )
        )

    query = (
        db.session.query(AiLinks)
        .join(Submissions, AiLinks.submission_id == Submissions.id)
        .join(Challenges, Submissions.challenge_id == Challenges.id)
        .filter(*filters)
    )

    pagination = query.order_by(AiLinks.date.desc()).paginate(
        page=page, per_page=50, error_out=False
    )

    args = dict(request.args)
    args.pop("page", 1)

    return render_template(
        "ai_submissions.html",
        submissions=pagination.items,
        pagination=pagination,
        prev_page=url_for(request.endpoint, page=pagination.prev_num, **args) if pagination.has_prev else None,
        next_page=url_for(request.endpoint, page=pagination.next_num, **args) if pagination.has_next else None,
        type=submission_type,
        q=q,
    )


@admin_ai_submissions.route("/admin/ai-submissions/links")
@admins_only
def admin_ai_submissions_links():
    submission_ids = request.args.get("submission_ids", "")
    ids = [i.strip() for i in submission_ids.split(",") if i.strip().isdigit()]
    if not ids:
        return jsonify({})

    rows = db.session.query(AiLinks).filter(AiLinks.submission_id.in_(ids)).all()
    return jsonify({str(row.submission_id): row.value for row in rows})


def load(app):
    with app.app_context():
        db.create_all()
        try:
            db.session.execute(
                text(
                    "ALTER TABLE ai_links "
                    "ADD COLUMN IF NOT EXISTS solver_file VARCHAR(255) NULL, "
                    "ADD COLUMN IF NOT EXISTS solver_name VARCHAR(255) NULL;"
                )
            )
            db.session.commit()
        except Exception:
            db.session.rollback()

    register_plugin_assets_directory(app, base_path="/plugins/ai_submissions/assets/")
    register_plugin_script("/plugins/ai_submissions/assets/ai_submissions.js")
    register_admin_plugin_script("/plugins/ai_submissions/assets/ai_submissions_admin.js")

    app.register_blueprint(admin_ai_submissions)

    CHALLENGE_CLASSES["standard"] = AiSubmissionStandardChallenge
    CHALLENGE_CLASSES["dynamic"] = AiSubmissionDynamicChallenge
    patch_dynamic_iac()

    upload_solver_file._bypass_csrf = True
    app.before_request(validate_and_swap)
