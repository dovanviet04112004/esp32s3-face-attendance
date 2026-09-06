/** Every GPIO number and bus setting the board is wired for.
 *  Mirrors KEHOACH section 2; the two must change in one commit (CLAUDE 1.3).
 */
#pragma once

#define APP_CAM_SIOD_GPIO 4                 // SCCB SDA, camera-only bus
#define APP_CAM_SIOC_GPIO 5                 // SCCB SCL, camera-only bus
#define APP_CAM_VSYNC_GPIO 6
#define APP_CAM_HREF_GPIO 7
#define APP_CAM_XCLK_GPIO 15
#define APP_CAM_PCLK_GPIO 13
#define APP_CAM_D0_GPIO 11
#define APP_CAM_D1_GPIO 9
#define APP_CAM_D2_GPIO 8
#define APP_CAM_D3_GPIO 10
#define APP_CAM_D4_GPIO 12
#define APP_CAM_D5_GPIO 18
#define APP_CAM_D6_GPIO 17
#define APP_CAM_D7_GPIO 16
#define APP_CAM_PWDN_GPIO (-1)              // not wired
#define APP_CAM_RESET_GPIO (-1)             // not wired
// OV5640 accepts 6-27 MHz on XCLK (DS rev 2.51 section 4.2).
#define APP_CAM_XCLK_HZ 27000000

#define APP_LCD_SCK_GPIO 42
#define APP_LCD_MOSI_GPIO 41
#define APP_LCD_CS_GPIO 47
// LCD boards pull DC up, and GPIO45 is VDD_SPI strapping: high at
// reset selects 1.8 V flash and the board does not boot (KEHOACH 2.3).
#define APP_LCD_DC_GPIO 39
#define APP_LCD_RST_GPIO 40
#define APP_LCD_BLK_GPIO 21
#define APP_LCD_H_RES 480
#define APP_LCD_V_RES 320
#define APP_LCD_SPI_HZ 40000000
#define APP_LCD_BLK_HZ 5000

#define APP_I2C_SDA_GPIO 1
#define APP_I2C_SCL_GPIO 2
#define APP_I2C_HZ 400000

#define APP_IOEXP_I2C_ADDR 0x20             // PCF8574, A2A1A0 tied to GND
// Every P line floats high at power-up through a ~100 uA source, so a
// line may only carry work where that level is harmless (KEHOACH 2.3).
#define APP_IOEXP_P_TOUCH_RST 0
#define APP_IOEXP_P_TOF_XSHUT 1
#define APP_IOEXP_P_RELAY_IN1 2
#define APP_IOEXP_P_AUDIO_SD 3

#define APP_TOUCH_INT_GPIO 14
#define APP_TOUCH_I2C_ADDR_LOW 0x5D         // INT held low during reset
#define APP_TOUCH_I2C_ADDR_HIGH 0x14        // INT held high during reset
// GT911 latches its address off INT the moment RST is released, which
// the expander does on its own at power-up (KEHOACH 2.3).
#define APP_TOUCH_RST_HOLD_MS 10
#define APP_TOUCH_INT_HOLD_MS 50

#define APP_TOF_INT_GPIO 3
#define APP_TOF_I2C_ADDR 0x29

#define APP_AUDIO_BCLK_GPIO 43              // frees U0TXD, needs USB-CDC console
#define APP_AUDIO_LRC_GPIO 44               // frees U0RXD, needs USB-CDC console
#define APP_AUDIO_DIN_GPIO 46

#define APP_SERVO_PWM_GPIO 38
#define APP_SERVO_HZ 50
#define APP_SERVO_MIN_US 500
#define APP_SERVO_MAX_US 2400

#define APP_STATUS_LED_GPIO 48              // WS2812 on board
#define APP_FACTORY_RESET_GPIO 0            // BOOT button
