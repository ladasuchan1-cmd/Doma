'use strict';
// Presety tří designů (SPEC kap. 7). Téma = soubor public/themes/<nazev>.css + layoutové varianty,
// které layout.js zapíše do atributů <html data-theme data-hero data-nav data-cards>.
// Vstup: žádný. Výstup: THEMES (slovník), THEME_NAMES, isTheme(), getTheme().

const THEMES = Object.freeze({
  outdoor: Object.freeze({
    label: 'Outdoor',
    hero: 'fullbleed',
    nav: 'transparent',
    cards: 'photo-top',
    fonts: Object.freeze({ display: 'Fraunces', body: 'Inter', accent: 'Caveat' }),
    css: '/themes/outdoor.css',
    hint: 'zemitý, fotografický, osobní',
    description:
      'Pro půjčovny u řek, rybníků a v chráněných krajinách. Krémové pozadí, lesní zelená a terakota, měkký serif Fraunces ' +
      'a ručně psané akcenty Caveat. Velké fotografie krajiny, klidný rytmus, mírně zaoblené rohy.',
  }),
  sport: Object.freeze({
    label: 'Sport',
    hero: 'video-or-duotone',
    nav: 'bar',
    cards: 'overlay',
    fonts: Object.freeze({ display: 'Barlow Condensed', body: 'Space Grotesk' }),
    css: '/themes/sport.css',
    hint: 'tmavý, kontrastní, dynamický',
    description:
      'Pro MTB, trailparky a závodní klientelu. Tmavé pozadí, limetková zelená s černým textem, červené CTA. Kondenzované ' +
      'verzálky Barlow Condensed s velkými číslovkami cen, Space Grotesk v textu, ostré rohy a diagonální řezy.',
  }),
  family: Object.freeze({
    label: 'Family',
    hero: 'split',
    nav: 'centered',
    cards: 'soft',
    fonts: Object.freeze({ display: 'Bricolage Grotesque', body: 'Nunito' }),
    css: '/themes/family.css',
    hint: 'světlý, vzdušný, přátelský',
    description:
      'Pro města, lázně a rodiny s dětmi. Bílá a mint, petrolejová primární barva, korálové CTA. Zaoblený Nunito, hravé ' +
      'titulky Bricolage Grotesque, pill tlačítka, měkké stíny a kroky 1-2-3.',
  }),
});

const THEME_NAMES = Object.freeze(Object.keys(THEMES));
const DEFAULT_THEME = 'outdoor';

/** Je hodnota název známého tématu? */
function isTheme(name) {
  return typeof name === 'string' && Object.hasOwn(THEMES, name);
}

/** Preset tématu (neznámé → výchozí outdoor). */
function getTheme(name) {
  return THEMES[isTheme(name) ? name : DEFAULT_THEME];
}

module.exports = { THEMES, THEME_NAMES, DEFAULT_THEME, isTheme, getTheme };
