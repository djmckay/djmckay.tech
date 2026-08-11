module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/css": "css" });
  eleventyConfig.addPassthroughCopy({ "src/vendor": "vendor" });
  eleventyConfig.addPassthroughCopy({ "src/img": "img" });
  eleventyConfig.addPassthroughCopy({ "src/scripts": "scripts" });

  // These directories are static assets copied as-is above; don't let
  // Eleventy also treat files inside them (e.g. a vendored README.md) as templates.
  eleventyConfig.ignores.add("src/vendor/**");
  eleventyConfig.ignores.add("src/css/**");
  eleventyConfig.ignores.add("src/img/**");
  eleventyConfig.ignores.add("src/scripts/**");

  eleventyConfig.addFilter("year", () => new Date().getFullYear());

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site"
    }
  };
};
