## Summary
Natively 2.0.3: Dynamic AI Model Selection, Multimodal Fallbacks & Architecture Polish

## What's New
- **Dynamic AI Model Selection:** Replaced static model lists with dynamic dropdowns. Your preferred models synced from providers (OpenAI, Anthropic, Google) now automatically appear across the entire app.
- **Multimodal Resilience:** Added a "Smart Dynamic Fallback" using Groq Llama 4 Scout. If default vision models fail or get rate-limited during screen analysis, Natively instantly reroutes the image to ensure uninterrupted performance.
- **Multiple Screenshot Support:** The Natively Interface can now handle and process multiple attached screenshots simultaneously instead of just one.

## Improvements
- **Improved Settings UX:** API keys now auto-save after 5 seconds of inactivity.
- **Instant UI Sync:** Selecting a preferred model immediately updates the rest of the application without requiring a page reload.
- **DRY Refactoring:** Centralized model configuration strings across the codebase to ensure easier future updates.

## Fixes
- **Claude Context Limits:** Resolved max_tokens and context limits issues specific to Anthropic Claude interactions.

## Technical
- **Better Embeddings:** Migrated from Gemini Embedding to a completely new and more robust embedding architecture.

## ⚠️macOS Installation (Unsigned Build)

Download the correct architecture .zip or .dmg file for your device (Apple Silicon or Intel).

If you see "App is damaged":
- **For .zip downloads:**
  1. Move the app to your Applications folder.
  2. Open Terminal and run: `xattr -cr /Applications/Natively.app`

- **For .dmg downloads:**
  1. Open Terminal and run: 
     ```bash
     xattr -cr ~/Downloads/Natively-2.0.2-arm64.dmg
     ```
  2. Install the natively.dmg
  3. Open Terminal and run: `xattr -cr /Applications/Natively.app`
