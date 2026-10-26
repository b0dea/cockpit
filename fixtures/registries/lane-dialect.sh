# Lane dialect — six fields: slug|dir|remote|lane|var|purpose
#
# A registry written by a cockpit that recorded how the STACK USES each checkout and left
# acquisition implicit: every row is cloned from its remote by setup.
#
# Deliberate properties, each one a real failure this fixture exists to keep tested:
#   web-client   slug, dir and remote are three different names, and the exported var
#                (WEB_DIR) does not derive from the slug (would be WEB_CLIENT_DIR)
#   dispatch     a profile lane, which stays off until EXTRA_PROFILES turns it on
#   mobile/shop  host lanes: a make target, never a compose service
EXAMPLE_SIBLINGS=(
    "api|example-api|api-service|app|API_DIR|the backend — every bring-up bind-mounts it"
    "web-client|example-web|web-frontend|app|WEB_DIR|the operator and customer frontend — every bring-up bind-mounts it"
    "dispatch|example-dispatch|dispatch|profile:dispatch|DISPATCH_DIR|EXTRA_PROFILES=dispatch — the dispatch product"
    "mobile|example-mobile|mobile-app|host|MOBILE_DIR|make mobile — the simulator dev-client (one platform only)"
    "storefront|example-shop|shop-theme|host|SHOP_DIR|make shop — the storefront theme (renders against the LIVE store)"
)
