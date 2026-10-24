package ai.artemis.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class NativeBridgeTest {
    @Test public void acceptsASixDigitHexColour() {
        assertEquals("#1a2B3c", NativeBridge.systemBarColor("{\"systemBarColor\": \"#1a2B3c\"}"));
    }

    @Test public void rejectsAnythingElse() {
        assertNull(NativeBridge.systemBarColor(null));
        assertNull(NativeBridge.systemBarColor("not json"));
        assertNull(NativeBridge.systemBarColor("{}"));
        assertNull(NativeBridge.systemBarColor("{\"systemBarColor\": 12}"));
        assertNull(NativeBridge.systemBarColor("{\"systemBarColor\": \"#fff\"}"));
        assertNull(NativeBridge.systemBarColor("{\"systemBarColor\": \"#1a2b3cff\"}"));
        assertNull(NativeBridge.systemBarColor("{\"systemBarColor\": \"red\"}"));
    }
}
