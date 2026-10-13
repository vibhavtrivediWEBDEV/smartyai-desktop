# Jarvis development

- Keep this application separate from other products and leave the enclosing Git repository's unrelated files alone.
- Runtime AI, when introduced, must be GLM-5 only; verify provider capabilities before integration, never bundle shared credentials, and do not claim unavailable features work.
- Keep operating-system actions in Electron main behind typed, validated IPC and centralized scoped permissions. Preserve context isolation, sandboxing and Node integration disabled.
- Keep commands truthful: confirm results before reporting success. Run `npm run build` and `npm test` for changes to desktop behavior.
- Distinguish implemented features from planned ones in the README and UI.