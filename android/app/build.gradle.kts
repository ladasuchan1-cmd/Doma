plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Sdílené JS knihovny (detekce, offline analýza, volání Claude, vykreslení) se berou
// z kořene repozitáře (../lib) – Android používá stejný engine jako rozšíření prohlížeče.
val jsLibDir = rootProject.file("../lib")
val generatedAssets = layout.buildDirectory.dir("generated/jslib")
val copyJsLibs by tasks.registering(Copy::class) {
    from(jsLibDir) { include("*.js") }
    into(generatedAssets.map { it.dir("lib") })
}

android {
    namespace = "cz.hlidacpodminek"
    compileSdk = 34

    defaultConfig {
        applicationId = "cz.hlidacpodminek"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(generatedAssets)
        }
    }

    // Dvě varianty aplikace:
    //  full – se službou přístupnosti (automatické čtení obrazovky). Google Play Protect ji při instalaci
    //         mimo Obchod Play blokuje („Aplikace byla za účelem ochrany zařízení zablokována“), dokud
    //         uživatel dočasně nevypne kontrolu aplikací v Play Protect nebo neinstaluje přes adb.
    //  lite – bez služby přístupnosti (src/lite/AndroidManifest.xml ji odebírá), takže projde Play Protect.
    //         Funguje ručně: Sdílet → Hlídač podmínek, menu označeného textu, vložení textu / odkazu.
    flavorDimensions += "variant"
    productFlavors {
        create("full") {
            dimension = "variant"
        }
        create("lite") {
            dimension = "variant"
            applicationIdSuffix = ".lite"
            versionNameSuffix = "-lite"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(copyJsLibs) }

// Aplikace záměrně nepoužívá AndroidX – jen framework API (menší APK, jednodušší build).
dependencies {}
