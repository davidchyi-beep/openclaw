package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
class ChatMessageMetadataWindowTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun openDetailsKeepTheCallersChangingTextDensity() {
    val scale = mutableStateOf(1.4f)
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale.value)) {
        ClawDesignTheme {
          ChatMessageTimestamp(1_789_776_060_000, listOf("Model" to "example-model"))
        }
      }
    }
    composeRule.onNode(hasClickAction()).performClick()
    for (expected in listOf(1.4f, 0.9f)) {
      composeRule.runOnIdle { scale.value = expected }
      val layouts = mutableListOf<TextLayoutResult>()
      composeRule
        .onNodeWithText("Model: example-model", useUnmergedTree = true)
        .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      assertEquals(
        expected,
        layouts
          .single()
          .layoutInput.density.fontScale,
        0.001f,
      )
    }
  }
}
