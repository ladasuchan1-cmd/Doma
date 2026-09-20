// Typová kontrola a jednotkové testy Kotlin zdrojáků aplikace Recepty bez Android SDK:
// kompiluje recepty/app/src/main/java proti android-all.jar (Robolectric, Maven Central) a vygenerované třídě R.
// Čistě kotlinská logika (extrakce ingrediencí, dotazy pro vyhledávání, rozpoznání odkazů) se testuje JUnitem.
// Spuštění:  python3 tools/gen-r.py recepty/app/src/main/res tools/recepty-typecheck/build/gen/cz/doma/recepty/R.java cz.doma.recepty
//            gradle -p tools/recepty-typecheck test
plugins { kotlin("jvm") version "2.0.21" }
repositories { mavenCentral() }
dependencies {
    compileOnly("org.robolectric:android-all:15-robolectric-13954326")
    testImplementation(kotlin("test"))
    testImplementation("org.json:json:20240303")
}
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../../recepty/app/src/main/java")
        java.srcDir("build/gen")
    }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions { freeCompilerArgs.add("-Xnullability-annotations=@androidx.annotation:warn") }
}
tasks.test { useJUnitPlatform() }
