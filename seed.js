/* Starting content for the album. Intentionally empty — everything is
   uploaded by the admin (macky). Works in the browser AND in the API. */
(function (root) {
  var seed = {
    texts: {},
    items: { pictures: [], videos: [], music: [], messages: [] }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = seed;
  else root.MW_SEED = seed;
})(typeof window !== 'undefined' ? window : this);
