# The deliberately broken control.
#
# Silence about a good fixture only means something if a bad one is named in the same run.
# Malformed rows must produce diagnostics instead of an indistinguishable empty success.
#
# Each row must appear in `skipped` with a reason that names what is wrong.
EXAMPLE_SIBLINGS=(
    "too|few|fields"
    "a|b|c|nonsense-lane|A_DIR|an unknown lane word must be reported, never mapped to a default"
    'b|c|d|app|B_DIR|single quotes are not a row bash would read here'
    "c|d|e|app|C_DIR|an unterminated row
    d|e|f|app|D_DIR|no quotes at all
)
