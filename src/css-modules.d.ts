/** CSS Modules are transformed into a class-name map by the bundler. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
