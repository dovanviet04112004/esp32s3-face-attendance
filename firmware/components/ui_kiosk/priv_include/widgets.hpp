/** The pieces every screen is built from, so they cannot drift apart.
 *  @ctx ui_task | non-blocking | geometry comes from theme.hpp, never from a caller
 */
#pragma once

#include <stdint.h>

#include "canvas.hpp"
#include "theme.hpp"

namespace ui {
namespace widgets {

enum class Icon : uint8_t {
    Wifi = 0,
    Lock,
    Person,
    PersonAdd,
    List,
    Device,
    Brightness,
    Volume,
    Keyboard,
    Backspace,
    Chevron,
    Back,
    Check,
    Close,
    Menu,
    None,
};

/** A line of a given thickness, rounded at both ends. */
void stroke(Canvas &to, int x0, int y0, int x1, int y1, int thick, uint8_t colour) noexcept;

/** Four rising bars, lit up to level. Bars read at 20 px where arcs turn to mush.
 *  @ctx ui_task | non-blocking | level 0 leaves every bar in rest
 */
void wifi_bars(Canvas &to, int x, int y, int size, int level, uint8_t colour,
               uint8_t rest) noexcept;

/** One glyph drawn inside a size box at x,y. */
void icon(Canvas &to, int x, int y, int size, Icon which, uint8_t colour) noexcept;

/** A tinted rounded square holding a white glyph, as every settings row has. */
void icon_tile(Canvas &to, int x, int y, int size, Icon which, uint8_t tint) noexcept;

/** The white card a group of rows sits on. */
void card(Canvas &to, int x, int y, int w, int h) noexcept;

/** The hairline between two rows of one card, inset past the icon tile. */
void divider(Canvas &to, int x, int y, int w) noexcept;

/** One touchable row: icon tile, label, grey value, chevron (KEHOACH 4.5.5h.4). */
struct Row {
    const char *label;
    const char *value;                    // NULL leaves the right side to the chevron
    Icon glyph;
    uint8_t tint;
    bool chevron;
    uint8_t label_colour;
    int bars;                             // 0..4 draws a meter, below 0 the tile
    Icon trail;                           // sits left of the value, None for none
};

void row(Canvas &to, int x, int y, int w, int h, const Row &what, bool pressed) noexcept;

/** A row whose right half is a track the finger drags. */
void slider_row(Canvas &to, int x, int y, int w, int h, Icon which, uint8_t tint, int percent,
                uint8_t colour) noexcept;

/** Where a touch inside a slider row lands, as a percentage. */
int slider_percent(int x, int row_x, int row_w) noexcept;

/** A key cap: rounded, with either a label or a glyph centred in it. */
void key_cap(Canvas &to, int x, int y, int w, int h, const char *label, Icon glyph, bool down,
             bool muted) noexcept;

/** A filled pill, the shape every confirm and cancel here takes. */
void button(Canvas &to, int x, int y, int w, int h, const char *label, uint8_t face, uint8_t ink,
            bool pressed) noexcept;

/** The title strip: a back chevron on the left when the screen has a parent. */
void header(Canvas &to, const char *title, bool back) noexcept;

/** Where the back chevron sits, so a screen can test a touch against it. */
bool on_back(int x, int y) noexcept;

/** The small grey heading above a card, as phone settings label their groups. */
void group_label(Canvas &to, int x, int y, int w, const char *text) noexcept;

}  // namespace widgets
}  // namespace ui
