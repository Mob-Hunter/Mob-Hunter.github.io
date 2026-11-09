plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mobhunter.agent"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mobhunter.agent"
        minSdk = 30
        targetSdk = 35
        versionCode = 10100
        versionName = "1.1.0"
    }

    // Release signing: supply the organisation's keystore via MH_KEYSTORE_PATH / MH_KEYSTORE_PASSWORD /
    // MH_KEY_ALIAS / MH_KEY_PASSWORD (CI secrets). Without them the APK is signed with the debug key and
    // is for evaluation only — see android/README.md.
    val releaseKeystore = System.getenv("MH_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("MH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("MH_KEY_ALIAS")
                keyPassword = System.getenv("MH_KEY_PASSWORD")
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
    testOptions { unitTests.isReturnDefaultValues = true }
    lint { abortOnError = false }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime:2.10.5")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("com.google.firebase:firebase-messaging:24.1.2")
    implementation("com.google.crypto.tink:tink-android:1.18.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
