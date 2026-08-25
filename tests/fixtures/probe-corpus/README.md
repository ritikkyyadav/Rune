# Probe false-positive corpus

Committed regression fixtures for the tool-result prompt-injection probe
(`scanForInjection` + the high-confidence bar). `benign/` holds realistic
content that historically risks false positives — credential vocabulary on
code lines, security documentation, base64/eval mentions, role-phrases in
prose — and must never produce a high-confidence finding. `malicious/` holds
genuine injection attempts that must always flag high. The unit test walks
both directories, so adding a file here IS adding a probe regression test.
