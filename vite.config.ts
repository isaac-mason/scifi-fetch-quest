import { defineConfig } from 'vite';

// Relative base: built asset URLs (and import.meta.env.BASE_URL, which src/scene.ts prepends to the
// runtime asset paths) resolve RELATIVE to the page. So the same build works at the domain root or
// under any project subpath (e.g. GitHub Pages /<repo>/) with no repo-name config.
export default defineConfig({
    base: './',
});
