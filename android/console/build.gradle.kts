plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fleetguard.console"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.fleetguard.console"
        minSdk = 26
        targetSdk = 35
        versionCode = 20100
        versionName = "2.1.0"
        // Production server the app opens by default (-PfgServerUrl=https://… or FG_SERVER_URL). Empty = ask on first launch.
        val server = (project.findProperty("fgServerUrl") as String?) ?: System.getenv("FG_SERVER_URL") ?: ""
        require(server.isEmpty() || server.startsWith("https://")) { "fgServerUrl must be https://" }
        resValue("string", "default_server_url", server)
    }

    // Release signing: supply the organisation's keystore via FG_KEYSTORE_PATH / FG_KEYSTORE_PASSWORD /
    // FG_KEY_ALIAS / FG_KEY_PASSWORD (CI secrets). Without them the APK is signed with the debug key and
    // is for evaluation only — see android/README.md.
    val releaseKeystore = System.getenv("FG_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("FG_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FG_KEY_ALIAS")
                keyPassword = System.getenv("FG_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = false }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

// Bundle the web console build (../../dist) so the app also works offline in demo mode.
val copyWebConsole by tasks.registering(Copy::class) {
    val dist = rootProject.file("../dist")
    doFirst { require(dist.resolve("index.html").exists()) { "Build the web console first: npm run build (in the repository root)" } }
    from(dist) { exclude("_headers") }
    into(layout.projectDirectory.dir("src/main/assets/www"))
}
tasks.named("preBuild") { dependsOn(copyWebConsole) }

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
}
