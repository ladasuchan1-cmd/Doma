package cz.doma.recepty.engine

/**
 * Slovník surovin pro offline rozpoznání: základní český název | kmeny slov (bez diakritiky, malými písmeny),
 * které se porovnávají jako předpony slov v textu. Pokrývá češtinu, slovenštinu a angličtinu.
 */
object IngredientDictionary {
    private val RAW = """
kuře|kure;kurec;kuret;chicken;kurca;kurac
hovězí|hovez;beef;steak;hovadz
vepřové|veprov;pork;bravcov;panenk;krkovic;kotlet;bucek;bok
mleté maso|mlete;mletym;mletem;ground beef;ground meat;minced meat;mince
slanina|slanin;bacon;pancett;guancial
šunka|sunk;ham;prosciutt
klobása|klobas;sausage;chorizo;salam;parek;wurst
krůta|krut;turkey;morc
kachna|kachn;duck
jehněčí|jehnec;lamb
ryba|ryb;fish;filet
losos|losos;salmon
tuňák|tunak;tuna
treska|tresk;cod
krevety|krevet;shrimp;prawn;garnat
tofu|tofu
vejce|vejce;vajec;vajick;egg;zloutk;bilk;yolk
mléko|mlek;milk;mliek
smetana|smetan;cream;slahack
máslo|masl;butter
sýr|syr;cheese;eidam;gouda;cheddar;hermelin;niva;balkan
parmazán|parmaz;parmez;parmig
mozzarella|mozzar;mozar
feta|feta
ricotta|ricott
tvaroh|tvaroh;quark;cottage
jogurt|jogurt;yogurt;yoghurt
zakysaná smetana|zakysan;sour cream;creme fraiche
kokosové mléko|kokosov;coconut milk
mouka|mouk;flour;muk
hladká mouka|hladk
polohrubá mouka|polohrub
špaldová mouka|spald;spelt
kukuřičná mouka|kukuricn;cornmeal;polent
ovesné vločky|vlock;oat;ovesn
rýže|ryz;rice;ryza
těstoviny|testovin;pasta;spaget;spaghett;penne;tagliatel;lasagn;fettucc;macaron;noodle;nudl;nudle;gnocc
kuskus|kuskus;couscous
bulgur|bulgur
quinoa|quino
pohanka|pohank;buckwheat
jáhly|jahl;millet
brambory|brambor;potato;zemiak
batáty|batat;sweet potato
chléb|chleb;bread;chlieb;toast;bageta;baguette;houska;rohlik;bun;pita;tortill;wrap
strouhanka|strouhank;breadcrumb;panko
cukr|cukr;sugar
třtinový cukr|trtinov;brown sugar
med|med;honey
javorový sirup|javorov;maple
vanilka|vanil
kakao|kakao;cocoa
čokoláda|cokolad;chocolate;cokolat
sůl|sul;soli;salt;sol
pepř|pepr;pepper;cierne korenie
olej|olej;oil
olivový olej|olivov;olive oil
sádlo|sadl;lard
ocet|ocet;vinegar;octa;balsamic;balzamik
sójová omáčka|sojov;soy sauce;soja
worcester|worcest
hořčice|horcic;mustard
kečup|kecup;ketchup
majonéza|majonez;mayo
rajčatový protlak|protlak;passata;tomato paste;pretlak
rajčata|rajc;tomato;paradajk;cherry
česnek|cesnek;garlic;cesnak
cibule|cibul;onion;salotk;shallot
jarní cibulka|jarni cibul;scallion;green onion;pazitk;chive
pórek|porek;leek
mrkev|mrkv;mrkev;carrot
celer|celer;celery
petržel|petrzel;parsley
paprika|paprik;bell pepper;capsicum
chilli|chilli;chili;jalape;feferon;habaner
zázvor|zazvor;ginger
kurkuma|kurkum;turmeric
kmín|kmin;cumin;caraway
koriandr|koriandr;coriander;cilantro
kari|kari;curry
skořice|skoric;cinnamon
paprika mletá|mlet paprik;uzena paprik;smoked paprika
oregano|oregan
bazalka|bazalk;basil
tymián|tymian;thyme
rozmarýn|rozmaryn;rosemary
máta|mata;mint
kopr|kopr;dill
bobkový list|bobkov;bay leaf
muškátový oříšek|muskat;nutmeg
hřebíček|hrebic;clove
sezam|sezam;sesame
mák|mak;poppy
špenát|spenat;spinach
brokolice|brokol;broccoli
květák|kvetak;cauliflower;karfiol
zelí|zeli;cabbage;kapust;kimchi;sauerkraut
kapusta|kelu;kale
cuketa|cuket;zucchini;courgette
lilek|lilek;eggplant;aubergine
dýně|dyn;pumpkin;squash;hokkaid
okurka|okurk;cucumber;uhork
salát|salat;lettuce;rukol;arugula;romain;icebergrocket
avokádo|avokad;avocado
kukuřice|kukuric;corn;sweetcorn
hrášek|hrasek;hrach;peas
fazole|fazol;beans;bean;kidney
cizrna|cizrn;chickpea;garbanzo
čočka|cock;cocka;lentil;sosovic
houby|houb;hub;mushroom;zampion;hliva;shiitake;portobell
olivy|oliv;olive
kapary|kapar;caper
chřest|chrest;asparagus
řepa|rep;beet;cvikl
ředkvičky|redkv;radish
jablka|jablk;jablek;apple
banán|banan;banana
citron|citron;lemon;citrus
limetka|limet;lime
pomeranč|pomeranc;orange
jahody|jahod;strawberr
maliny|malin;raspberr
borůvky|boruvk;blueberr;cucoriedk
třešně|tresn;cherr;visn
hrušky|hrusk;pear
švestky|svestk;plum;slivk
broskve|broskv;peach;merunk;apricot;nektarink
hrozny|hrozn;grape;rozink;raisin;hrozienk
mango|mango
ananas|ananas;pineapple
kokos|kokos;coconut
datle|datl;date
ořechy|orech;nut;vlassk;walnut;pecan;liskov;hazelnut;kesu;cashew;pistac
mandle|mandl;almond
arašídy|arasid;peanut;burak
slunečnicová semínka|slunecnic;sunflower
dýňová semínka|dynov semin;pumpkin seed
lněné semínko|lnen;flax;linseed
chia|chia
droždí|drozd;kvasnic;yeast;kvasnice
prášek do pečiva|prasek do peciv;baking powder;kypric
jedlá soda|jedla soda;baking soda;bicarbon
škrob|skrob;starch;solamyl;maizen;cornstarch
želatina|zelatin;gelatin;agar
vývar|vyvar;broth;stock;bujon;bouillon
víno|vino;wine;vin
pivo|pivo;beer
rum|rum
káva|kava;coffee;espresso
čaj|caj;tea;matcha
voda|vod;water
kokosový olej|kokosov olej;coconut oil
arašídové máslo|arasidov masl;peanut butter
tahini|tahini
kondenzované mléko|kondenz;condensed milk;salko
sušenky|susenk;cookie;biscuit;piskot;ladyfinger
pudink|pudink;pudding
zmrzlina|zmrzlin;ice cream
tortilla|tortill
lístkové těsto|listkov;puff pastry
kynuté těsto|kynut;dough
""".trimIndent()

    class Entry(val name: String, val stems: List<String>)

    val entries: List<Entry> by lazy {
        RAW.lines().filter { it.isNotBlank() && it.contains('|') }.map { line ->
            val name = line.substringBefore('|').trim()
            val stems = line.substringAfter('|').split(';').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            Entry(name, stems)
        }
    }

    /** Základní název suroviny, pokud text (jedno slovo nebo krátká fráze) odpovídá slovníku. */
    fun canonical(phrase: String): String? {
        val folded = TextUtil.fold(phrase)
        val words = folded.split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }
        var best: Entry? = null
        var bestLen = 0
        for (e in entries) for (s in e.stems) {
            val hit = if (s.contains(' ')) folded.contains(s) else words.any { w -> matchesStem(w, s) }
            if (hit && s.length > bestLen) { best = e; bestLen = s.length }
        }
        return best?.name
    }

    /** Všechny suroviny ze slovníku zmíněné v textu (v pořadí výskytu, bez duplicit). */
    fun findAll(text: String): List<String> {
        val folded = TextUtil.fold(text)
        val words = folded.split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }
        val found = LinkedHashMap<String, Int>()
        for (e in entries) {
            var pos = -1
            for (s in e.stems) {
                if (s.contains(' ')) {
                    val i = folded.indexOf(s); if (i >= 0 && (pos < 0 || i < pos)) pos = i
                } else {
                    var offset = 0
                    for (w in words) {
                        if (matchesStem(w, s)) { val i = folded.indexOf(w, offset); if (pos < 0 || (i in 0 until pos)) pos = i; break }
                        offset = folded.indexOf(w, offset) + w.length
                    }
                }
            }
            if (pos >= 0 && !found.containsKey(e.name)) found[e.name] = pos
        }
        return found.entries.sortedBy { it.value }.map { it.key }
    }

    private fun matchesStem(word: String, stem: String): Boolean {
        if (stem.length <= 3) return word == stem || (word.startsWith(stem) && word.length <= stem.length + 1)
        return word.startsWith(stem) && word.length <= stem.length + 6
    }
}
