/**
 * Single door to @streampolis/shared.
 *
 * The shared package ships raw .ts and is consumed by Vite on the client. Node
 * cannot import it directly (its internal `./x.js` specifiers do not resolve
 * against .ts files), so the server compiles that source into its own dist and
 * reaches it through this relative re-export. Every other server module imports
 * from here — never from '@streampolis/shared'.
 */
export * from '../../shared/src/index.js';
