// Published entrypoints and their entire module graph share one version.
export function versionModuleImports(source,version){
 return source.replace(/(from\s+)(['"])(\.\/[^'"]+\.js)\2/g,(_,prefix,quote,path)=>`${prefix}${quote}${path}?v=${encodeURIComponent(version)}${quote}`);
}
export function versionHtmlAssets(html,version){
 return html.replace(/(src="app\.js|href="styles\.css)(")/g,`$1?v=${encodeURIComponent(version)}$2`);
}
