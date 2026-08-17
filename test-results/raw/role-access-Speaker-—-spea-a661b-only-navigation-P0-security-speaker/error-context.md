# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: role-access.spec.js >> Speaker — speaker dashboard @speaker >> does not expose another speaker identity through URL-only navigation @P0 @security
- Location: tests/e2e/role-access.spec.js:70:3

# Error details

```
Error: Error reading storage state from tests/.auth/speaker.json:
ENOENT: no such file or directory, open 'tests/.auth/speaker.json'
```