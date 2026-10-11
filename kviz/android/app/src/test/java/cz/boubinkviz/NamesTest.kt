package cz.boubinkviz

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NamesTest {
    private val quizzes = (1..4).map { Library.parse("kviz-boubin-0$it.html", File("../../web/kviz-boubin-0$it.html").readText()) }
    private val clips = quizzes.flatMap { it.clips }.distinctBy { it.key }

    /** Obsah složek videos a hudba na Disku Google (Kviz), ze kterého se ukázky nahrávají. */
    private val drive = listOf(
        "VYKOUPENI_Z_VEZNICE_SHAWSENK.mp4", "TITANIC.mp4", "TERMINÁTOR_2.mp4", "trapaslik.mp4", "SEDM.mp4",
        "zabil_jsem_einstina_panove.mp4", "vsichni_dobri_rodaci.mp4", "sberatele_kosti.mp4", "pulp_fiction.mp4", "počátek.mp4",
        "ranc_u_zelene_sedmy.mp4", "rozsudky_soudce_ooky.mp4", "tajemstvi_stare_bambitky_2.mp4", "slavnosti_snezenek.mp4",
        "smrt_krasnych_srncu.mp4", "POSLEDNI_SAMURAJ.mp4", "pritelkyne_z_domu_smutku.mp4", "princove_jsou_na_draka.mp4",
        "paty_element.mp4", "matrix.mp4", "minority_report.mp4", "most.mp4", "postriziny.mp4", "letajici_cestmir.mp4",
        "GLADIATOR.mp4", "lado_ty_si_princezna.mp4", "DEN_NEZAVISLOSTI.mp4", "kocar_nejsvetejsi_svatosti.mp4",
        "hrisni_lide_mesta_prazskeho.mp4", "jak_dostat_tatinka_do_polepsovny.mp4", "dvanact_mesicku.mp4", "dilino_a_cert.mp4",
        "klub_rvacu.mp4", "blade.mp4", "roaming.mp4", "bony_a_klid.mp4", "certovna_stena.mp4", "americka_krasa.mp4",
        "coz_takhle_dat_si_spenat.mp4", "bohouš.mp4", "cerveny_trpaslik.mp4", "pelisky.mp4", "raduz_a_mahulena.mp4",
        "Whitney_Houston_-_I_Will_Always_Love_You.mp4", "Sinead_O_Connor_-_Nothing_Compares_2_U.mp4",
        "Ray_Charles_-_Hit_the_road_Jack.mp4", "Duet_-_Robbie_Williams__Nicole_Kidman_-_Somethin__Stupid.mp4",
        "Duet_-_Lady_Gaga_a_Bradley_Cooper_-_Shallow.mp4", "Nick_Kershaw_-_The_Riddle.mp4",
        "George_Harrison_-_Got_My_Mind_Set_on_You.mp4", "Dolly_Parton_-_Jolene.mp4", "Depeche_Mode_-_But_Not_Tonight.mp4",
        "Dean_Martin_-_Everybody_Loves_Somebody.mp4", "Céline_Dion_-_It_s_All_Coming_Back_to_Me_Now.mp4",
        "Amy_Winehouse_-_Back_To_Black.mp4", "R_E_M__-_Shiny_Happy_People.mp4", "Roxette_-_Joyride.mp4",
        "Bryand_Adams_-_Summer_Of__69.mp4", "Prince_-_Raspberry_Beret.mp4", "Belinda_Carlslile_-_Heaven_is_a_Place_on_Earth_.mp4",
        "Franks_Sinatra_-_Killing_me_softly.mp4", "Aretha_Franklin_-_Respect.mp4", "Alanis_Morissette_-_Ironic.mp4",
    )

    private fun assign(files: List<String>) = Names.assign(clips.map { it.key to it.names }, files.map { it to it })

    @Test fun parsesAllFourQuizzes() {
        assertEquals(4, quizzes.size)
        quizzes.forEachIndexed { i, q ->
            assertEquals("Boubínské rodinné kvízování ${i + 1}", q.title)
            assertEquals(10, q.rounds.size)
            assertEquals(10, q.clips.size)
        }
        assertEquals(40, clips.size)
        assertEquals("Film 1 · TITANIC.mp4", quizzes[0].clips[0].label)
    }

    @Test fun normMatchesQuizScript() {
        assertEquals("terminator2", Names.norm("TERMINÁTOR_2.mp4"))
        assertEquals("terminator2", Names.norm("TERMINÁTOR_2.mp4"))
        assertEquals("duetrobbiewilliamsnicolekidmansomethinstupid", Names.norm("Duet - Robbie Williams, Nicole Kidman - Somethin´ Stupid.mp4"))
        assertEquals("pocatek", Names.norm("počátek.mp4"))
    }

    @Test fun everyClipIsInTheDriveFolderUnderItsExactName() {
        val m = assign(drive)
        assertEquals(clips.map { it.key }.toSet(), m.keys)
        assertTrue(m.values.all { it.exact })
        assertEquals(40, m.values.map { it.item }.toSet().size)
    }

    @Test fun renamedFilesAreFoundBySimilarName() {
        val m = assign(listOf("Duet - Robbie Williams, Nicole Kidman - Somethin’ Stupid.mp4", "Titanic (1997) ukázka.mp4", "Gladiator.MOV"))
        assertEquals("Duet - Robbie Williams, Nicole Kidman - Somethin’ Stupid.mp4", m.getValue(Names.norm("Duet_-_Robbie_Williams__Nicole_Kidman_-_Somethin__Stupid.mp4")).item)
        assertTrue(m.getValue("duetrobbiewilliamsnicolekidmansomethinstupid").exact)
        assertEquals("Titanic (1997) ukázka.mp4", m.getValue("titanic").item)
        assertFalse(m.getValue("titanic").exact)
        assertTrue(m.getValue("gladiator").exact)
        assertEquals(3, m.size)
    }

    @Test fun oneFileIsNeverUsedTwiceAndExactWins() {
        // „ranc_u_zelene_sedmy“ obsahuje „sedm“ – když je vybraný i SEDM.mp4, musí vyhrát přesná shoda.
        val m = assign(listOf("ranc_u_zelene_sedmy.mp4", "SEDM.mp4"))
        assertEquals("SEDM.mp4", m.getValue("sedm").item)
        assertEquals(1, m.size)
    }

    @Test fun unrelatedFilesAreSkipped() {
        assertTrue(assign(listOf("dovolena_2024.mp4", "IMG_0001.mp4", "pulp_fiction.mp4")).isEmpty())
    }

    @Test fun rangeHeader() {
        assertNull(Ranges.parse(null, 100))
        assertNull(Ranges.parse("bytes=-", 100))
        assertEquals(0L..99L, Ranges.parse("bytes=0-", 100))
        assertEquals(10L..19L, Ranges.parse("bytes=10-19", 100))
        assertEquals(90L..99L, Ranges.parse("bytes=90-500", 100))
        assertEquals(80L..99L, Ranges.parse("bytes=-20", 100))
        assertEquals(0L..99L, Ranges.parse("bytes=-500", 100))
        assertTrue(Ranges.parse("bytes=100-", 100)!!.isEmpty())
        assertTrue(Ranges.parse("bytes=50-10", 100)!!.isEmpty())
    }
}
