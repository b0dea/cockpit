# Tier dialect — seven fields: slug|dir|remote|branch|tier|var|purpose
#
# A registry written by a cockpit that recorded how each checkout REACHES THE DISK and left
# the mount implicit. A registry read must infer every mount here, and say so.
#
# Deliberate properties, each one a real failure this fixture exists to keep tested:
#   renderer     exports ENGINE_DIR — a var that flatly contradicts its slug, kept because
#                deriving it would silently produce an unset variable everywhere
#   local-dumps  tier `local`: not a repo, no remote, no branch, never cloned
#   booking      the activating profile is recoverable only from the purpose prose
#   docs/renderer  host lanes, recoverable only from `make <target>` in the purpose
#   infra/marketing/desktop  read by a session, never mounted by the stack
EXAMPLE_SIBLINGS=(
  "app|example-app|app|develop|required|APP_DIR|the app the stack bind-mounts — every container runs this working tree"
  "booking|example-booking|booking-companion|main|manual|BOOKING_DIR|EXTRA_PROFILES=booking (the booking companion)"
  "infra|example-infra|infra|main|auto|INFRA_DIR|the GitOps repo — its runbooks, and the cluster state a stack failure is often really about"
  "docs|example-docs|docs|main|auto|DOCS_DIR|make screenshots — it owns the capture manifest and the committed images"
  "renderer|example-renderer|render-engine|main|auto|ENGINE_DIR|make screenshots — the engine that replays the capture specs"
  "marketing|example-marketing|marketing-site|main|auto|MARKETING_DIR|the public marketing site and its own locked brand sheet"
  "desktop|example-desktop|desktop|main|auto|DESKTOP_DIR|the desktop client — it pairs against the running stack's upload endpoint"
  "local-dumps|example-local|-|-|local|LOCAL_DIR|anonymised production dumps — referenced by path only, never cloned or copied"
)
