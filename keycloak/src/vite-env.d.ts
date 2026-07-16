/// <reference types="vite/client" />

// Self-hosted @fontsource packages are imported for their side effects (they
// inject @font-face rules); they ship no type declarations.
declare module "@fontsource-variable/*";
declare module "@fontsource/*";
