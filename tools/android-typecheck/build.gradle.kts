// Typová kontrola Kotlin zdrojáků Android aplikace bez Android SDK:
// kompiluje app/src/main/java proti android-all.jar (Robolectric, Maven Central) a vygenerované třídě R.
// Spuštění:  python3 tools/gen-r.py android/app/src/main/res tools/android-typecheck/build/gen/cz/hlidacpodminek/R.java cz.hlidacpodminek
//            gradle -p tools/android-typecheck compileKotlin
plugins { kotlin("jvm") version "2.0.21" }
repositories { mavenCentral() }
dependencies {
    compileOnly("org.robolectric:android-all:15-robolectric-13954326")
}
kotlin { jvmToolchain(21) }
sourceSets {
    main {
        kotlin.srcDir("../../android/app/src/main/java")
        java.srcDir("build/gen")
    }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions { freeCompilerArgs.add("-Xnullability-annotations=@androidx.annotation:warn") }
}
