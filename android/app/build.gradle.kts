/* app —— Android 应用（Jetpack Compose）
 *
 * 包名与 iOS bundle id 对齐：com.peter260807.xiangqicoach
 * ⚠️ applicationId 一旦发布就不能改（等于换了应用，用户要卸载重装），
 *    所以在第一次打 APK 之前就定死在这里。
 */
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.peter260807.xiangqicoach"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.peter260807.xiangqicoach"
        // minSdk 26：Compose 与 java.time 都能直接用，覆盖 2017 年之后的机器。
        // 再往下降（24）要开 core library desugaring，首版不划算。
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        resourceConfigurations += listOf("zh", "en")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // 首版先用 debug 签名打 release APK，方便真机安装；
            // 正式分发时换成 keystore.properties 里的 release 签名。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    implementation(project(":engine"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    // ⚠️ 刻意**不引** material-icons-extended：它把上千个矢量图标全打进 APK，
    // 一个只有占位页的 debug 包会从 3 MB 涨到 16 MB。首版界面要用的图标
    // （提示 / 悔棋 / 重开 / 设置 / 分享）在 `material-icons-core` 里都有，
    // 需要额外图标时优先自绘 path，而不是引这个包。
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.kotlinx.serialization.json)

    /* ⚠️ 对局流程的集成测试用 **Robolectric** 而不是 instrumented test：
       `tap → 选中 → 落子 → 动画 → 电脑走棋` 这条链是纯逻辑，
       跑在 JVM 上几秒就有结果；换成 instrumented test 要起模拟器、慢几十倍，
       结果就是「没人愿意跑」。这也是 `GameFlowTest` 存在的前提 ——
       engine 模块的单测证明不了这条链（我正是在模拟器上撞到过）。 */
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
