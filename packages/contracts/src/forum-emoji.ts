// What linux.do shows each emoji of a link as. Its posts draw every emoji as
// an image whose text is :name:, so a link copied from a post comes out as
// /:red_envelope:/:chart_decreasing::window:…:hot_beverage:. Captured from
// the forum on 2026-10-18 by pasting every emoji below into a post.
import { ECOJI_V2_ALPHABET } from "./ecoji-v2/alphabet";

/** The names of the link alphabet, in its order (space-separated). */
const ALPHABET_NAMES = (
  "mahjong_red_dragon joker alarm_clock hourglass_not_done " +
  "umbrella_with_rain_drops aries taurus gemini cancer leo virgo " +
  "libra scorpio sagittarius capricorn aquarius pisces " +
  "wheelchair_symbol anchor high_voltage soccer_ball baseball " +
  "snowman_without_snow sun_behind_cloud ophiuchus no_entry church " +
  "fountain in_hole sailboat tent fuel_pump raised_fist raised_hand " +
  "sparkles star hindu_temple hut elevator playground_slide wheel " +
  "ring_buoy auto_rickshaw japanese_here_button pickup_truck " +
  "pinched_fingers pinching_hand diving_mask yawning_face " +
  "smiling_face_with_tear disguised_face face_holding_back_tears " +
  "sari mammoth dodo sloth otter orangutan cyclone foggy " +
  "closed_umbrella night_with_stars sunrise_over_mountains sunrise " +
  "cityscape_at_dusk sunset rainbow bridge_at_night ocean volcano " +
  "milky_way globe_showing_europe_africa globe_showing_americas " +
  "globe_showing_asia_australia globe_with_meridians new_moon " +
  "waxing_crescent_moon first_quarter_moon waxing_gibbous_moon " +
  "full_moon waning_gibbous_moon last_quarter_moon " +
  "waning_crescent_moon crescent_moon new_moon_face " +
  "first_quarter_moon_face last_quarter_moon_face full_moon_face " +
  "sun_with_face glowing_star shooting_star skunk flamingo oyster " +
  "beaver bison seal guide_dog white_cane safety_vest " +
  "ear_with_hearing_aid hot_dog taco burrito chestnut seedling " +
  "evergreen_tree deciduous_tree palm_tree cactus " +
  "motorized_wheelchair tulip cherry_blossom rose hibiscus sunflower " +
  "blossom ear_of_corn sheaf_of_rice herb four_leaf_clover " +
  "maple_leaf fallen_leaf leaf_fluttering_in_wind mushroom tomato " +
  "eggplant grapes melon watermelon tangerine lemon banana pineapple " +
  "red_apple green_apple pear peach cherries strawberry hamburger " +
  "pizza meat_on_bone poultry_leg rice_cracker rice_ball cooked_rice " +
  "curry_rice steaming_bowl spaghetti bread french_fries " +
  "roasted_sweet_potato dango oden sushi fried_shrimp " +
  "fish_cake_with_swirl soft_ice_cream shaved_ice ice_cream doughnut " +
  "cookie chocolate_bar candy lollipop custard honey_pot shortcake " +
  "bento_box pot_of_food cooking fork_and_knife " +
  "teacup_without_handle sake wine_glass cocktail_glass " +
  "tropical_drink beer_mug clinking_beer_mugs baby_bottle " +
  "manual_wheelchair bottle_with_popping_cork popcorn ribbon " +
  "wrapped_gift birthday_cake jack_o_lantern christmas_tree " +
  "santa_claus fireworks sparkler balloon tada confetti_ball " +
  "tanabata_tree crossed_flags pine_decoration japanese_dolls " +
  "carp_streamer wind_chime moon_viewing_ceremony backpack " +
  "graduation_cap mechanical_arm mechanical_leg beverage_box garlic " +
  "onion falafel waffle carousel_horse ferris_wheel roller_coaster " +
  "fishing_pole microphone movie_camera butter headphone " +
  "artist_palette top_hat circus_tent ticket clapper_board " +
  "performing_arts video_game bullseye slot_machine pool_8_ball " +
  "game_die bowling flower_playing_cards musical_note musical_notes " +
  "saxophone guitar musical_keyboard trumpet violin musical_score " +
  "running_shirt tennis skis basketball chequered_flag snowboarder " +
  "person_running person_surfing sports_medal trophy horse_racing " +
  "american_football rugby_football person_swimming mate ice " +
  "bubble_tea cricket_game volleyball field_hockey ice_hockey " +
  "ping_pong troll person_standing person_kneeling deaf_person " +
  "person_in_steamy_room person_climbing person_in_lotus_position " +
  "mage fairy vampire merperson elf house house_with_garden " +
  "office_building japanese_post_office post_office hospital bank " +
  "genie hotel love_hotel convenience_store school department_store " +
  "factory red_paper_lantern japanese_castle castle zombie " +
  "black_flag brain billed_cap badminton bow_and_arrow amphora scarf " +
  "gloves coat socks red_envelope rat mouse ox water_buffalo cow " +
  "tiger leopard rabbit cat dragon crocodile whale snail snake horse " +
  "ram goat ewe monkey rooster chicken dog pig boar elephant octopus " +
  "spiral_shell bug ant honeybee lady_beetle fish tropical_fish " +
  "blowfish turtle hatching_chick baby_chick front_facing_baby_chick " +
  "bird penguin koala poodle camel two_hump_camel dolphin mouse_face " +
  "cow_face tiger_face rabbit_face cat_face dragon_face " +
  "spouting_whale horse_face monkey_face dog_face pig_face frog " +
  "hamster wolf bear panda pig_nose paw_prints firecracker eyes " +
  "puzzle_piece ear nose mouth tongue backhand_index_pointing_up " +
  "backhand_index_pointing_down backhand_index_pointing_left " +
  "backhand_index_pointing_right oncoming_fist waving_hand ok_hand " +
  "+1 -1 clap open_hands crown woman_s_hat glasses necktie t_shirt " +
  "jeans dress kimono bikini woman_s_clothes purse handbag " +
  "clutch_bag man_s_shoe running_shoe high_heeled_shoe " +
  "woman_s_sandal woman_s_boot footprints bust_in_silhouette " +
  "busts_in_silhouette boy girl man woman family " +
  "woman_and_man_holding_hands men_holding_hands women_holding_hands " +
  "police_officer people_with_bunny_ears person_with_veil " +
  "person_blond_hair person_with_skullcap person_wearing_turban " +
  "old_man old_woman baby construction_worker princess ogre goblin " +
  "ghost baby_angel alien alien_monster angry_face_with_horns skull " +
  "person_tipping_hand guard woman_dancing lipstick nail_polish " +
  "person_getting_massage person_getting_haircut barber_pole syringe " +
  "pill kiss_mark love_letter ring gem_stone kiss bouquet " +
  "couple_with_heart wedding beating_heart broken_heart two_hearts " +
  "sparkling_heart growing_heart heart_with_arrow blue_heart " +
  "green_heart yellow_heart purple_heart heart_with_ribbon " +
  "revolving_hearts heart_decoration diamond_with_a_dot light_bulb " +
  "anger_symbol bomb zzz collision sweat_droplets droplet " +
  "dashing_away poop flexed_biceps dizzy speech_balloon " +
  "thought_balloon white_flower 100 money_bag currency_exchange " +
  "heavy_dollar_sign credit_card yen_banknote dollar_banknote " +
  "euro_banknote pound_banknote money_with_wings test_tube seat " +
  "laptop briefcase computer_disk floppy_disk optical_disk dvd " +
  "petri_dish open_file_folder page_with_curl page_facing_up dna " +
  "tear_off_calendar card_index chart_increasing chart_decreasing " +
  "bar_chart clipboard pushpin round_pushpin paperclip " +
  "straight_ruler triangular_ruler ledger notebook " +
  "notebook_with_decorative_cover closed_book open_book green_book " +
  "blue_book orange_book books name_badge scroll memo " +
  "telephone_receiver pager fax_machine satellite_antenna " +
  "loudspeaker megaphone outbox_tray inbox_tray package e_mail " +
  "incoming_envelope envelope_with_arrow " +
  "closed_mailbox_with_lowered_flag closed_mailbox_with_raised_flag " +
  "open_mailbox_with_raised_flag open_mailbox_with_lowered_flag " +
  "postbox postal_horn newspaper mobile_phone " +
  "mobile_phone_with_arrow vibration_mode compass no_mobile_phones " +
  "antenna_bars camera camera_with_flash video_camera television " +
  "radio videocassette abacus prayer_beads fire_extinguisher toolbox " +
  "brick magnet luggage dim_button bright_button muted_speaker " +
  "speaker_low_volume speaker_medium_volume speaker_high_volume " +
  "battery electric_plug magnifying_glass_tilted_left " +
  "magnifying_glass_tilted_right locked_with_pen locked_with_key key " +
  "locked unlocked bell bell_with_slash bookmark link radio_button " +
  "lotion_bottle thread yarn safety_pin teddy_bear broom basket " +
  "roll_of_paper soap sponge receipt nazar_amulet fire flashlight " +
  "wrench hammer nut_and_bolt kitchen_knife water_pistol microscope " +
  "telescope crystal_ball dotted_six_pointed_star " +
  "japanese_symbol_for_beginner trident_emblem black_square_button " +
  "white_square_button ballet_shoes one_piece_swimsuit briefs shorts " +
  "thong_sandal drop_of_blood adhesive_bandage stethoscope x_ray " +
  "crutch yoyo kite kaaba mosque synagogue menorah parachute " +
  "boomerang magic_wand piñata nesting_dolls ringed_planet chair " +
  "razor axe diya_lamp banjo military_helmet accordion long_drum " +
  "coin carpentry_saw screwdriver ladder hook mirror window plunger " +
  "sewing_needle knot bucket mouse_trap toothbrush headstone placard " +
  "rock mirror_ball identification_card low_battery man_dancing " +
  "hamsa fly worm beetle cockroach potted_plant fu vulcan_salute " +
  "black_heart wood feather lotus coral empty_nest nest_with_eggs " +
  "anatomical_heart lungs people_hugging pregnant_man " +
  "pregnant_person person_with_crown blueberries bell_pepper olive " +
  "flatbread tamale fondue teapot pouring_liquid mount_fuji " +
  "tokyo_tower statue_of_liberty map_of_japan moai grinning_face " +
  "grin joy smiley grinning_face_with_smiling_eyes sweat_smile " +
  "laughing innocent smiling_face_with_horns wink blush " +
  "face_savoring_food relieved_face heart_eyes " +
  "smiling_face_with_sunglasses smirking_face neutral_face " +
  "expressionless_face unamused_face downcast_face_with_sweat " +
  "pensive_face confused confounded_face kissing_face " +
  "face_blowing_a_kiss kissing_face_with_smiling_eyes " +
  "kissing_face_with_closed_eyes face_with_tongue " +
  "winking_face_with_tongue squinting_face_with_tongue " +
  "disappointed_face worried angry enraged_face cry persevering_face " +
  "face_with_steam_from_nose sad_but_relieved_face " +
  "frowning_face_with_open_mouth anguished_face fearful weary_face " +
  "sleepy_face tired_face grimacing sob open_mouth hushed_face " +
  "anxious_face_with_sweat scream astonished_face flushed_face " +
  "sleeping_face face_with_crossed_out_eyes face_without_mouth " +
  "face_with_medical_mask grinning_cat_with_smiling_eyes joy_cat " +
  "grinning_cat smiling_cat_with_heart_eyes cat_with_wry_smile " +
  "kissing_cat pouting_cat crying_cat weary_cat " +
  "slightly_frowning_face slightly_smiling_face upside_down_face " +
  "roll_eyes person_gesturing_no person_gesturing_ok person_bowing " +
  "see_no_evil_monkey hear_no_evil_monkey speak_no_evil_monkey " +
  "raising_hands person_frowning person_pouting folded_hands rocket " +
  "helicopter locomotive railway_car high_speed_train bullet_train " +
  "train metro light_rail station tram tram_car bus oncoming_bus " +
  "trolleybus bus_stop minibus ambulance fire_engine police_car " +
  "oncoming_police_car taxi oncoming_taxi automobile " +
  "oncoming_automobile sport_utility_vehicle delivery_truck " +
  "articulated_lorry tractor monorail mountain_railway " +
  "suspension_railway mountain_cableway aerial_tramway ship " +
  "person_rowing_boat speedboat horizontal_traffic_light " +
  "vertical_traffic_light construction police_car_light " +
  "triangular_flag door prohibited cigarette no_smoking " +
  "litter_in_bin_sign no_littering potable_water non_potable_water " +
  "bicycle no_bicycles person_biking person_mountain_biking " +
  "person_walking no_pedestrians children_crossing men_s_room " +
  "women_s_room restroom baby_symbol toilet water_closet shower " +
  "person_taking_bath bathtub passport_control customs baggage_claim " +
  "left_luggage beans person_in_bed jar melting_face saluting_face " +
  "place_of_worship stop_sign shopping_cart " +
  "face_with_open_eyes_and_hand_over_mouth face_with_peeking_eye " +
  "face_with_diagonal_mouth dotted_line_face biting_lip bubbles " +
  "hand_with_index_finger_and_thumb_crossed airplane_departure " +
  "airplane_arrival rightwards_hand leftwards_hand kick_scooter " +
  "motor_scooter canoe sled flying_saucer skateboard " +
  "zipper_mouth_face money_mouth_face face_with_thermometer " +
  "nerd_face thinking face_with_head_bandage robot hugs " +
  "sign_of_the_horns call_me_hand raised_back_of_hand " +
  "left_facing_fist right_facing_fist handshake crossed_fingers " +
  "love_you_gesture cowboy_hat_face clown_face nauseated_face rofl " +
  "drooling_face lying_face person_facepalming sneezing_face " +
  "face_with_raised_eyebrow star_struck zany_face shushing_face " +
  "face_with_symbols_on_mouth face_with_hand_over_mouth " +
  "face_vomiting exploding_head pregnant_woman breast_feeding " +
  "palms_up_together selfie prince person_in_tuxedo mrs_claus " +
  "person_shrugging person_cartwheeling person_juggling " +
  "person_fencing people_wrestling person_playing_water_polo " +
  "person_playing_handball wilted_flower drum clinking_glasses " +
  "tumbler_glass spoon goal_net 1st_place_medal 2nd_place_medal " +
  "3rd_place_medal boxing_glove martial_arts_uniform curling_stone " +
  "lacrosse softball flying_disc croissant avocado cucumber bacon " +
  "potato carrot baguette_bread green_salad shallow_pan_of_food " +
  "stuffed_flatbread egg glass_of_milk peanuts kiwi_fruit pancakes " +
  "dumpling fortune_cookie takeout_box chopsticks bowl_with_spoon " +
  "cup_with_straw coconut broccoli pie pretzel cut_of_meat sandwich " +
  "canned_food leafy_green mango moon_cake bagel " +
  "smiling_face_with_three_hearts partying_face woozy_face hot_face " +
  "cold_face pleading_face lab_coat goggles hiking_boot flat_shoe " +
  "crab lion scorpion turkey unicorn eagle duck bat shark owl fox " +
  "butterfly deer gorilla lizard rhinoceros shrimp squid giraffe " +
  "zebra hedgehog sauropod t_rex cricket kangaroo llama peacock " +
  "hippopotamus parrot raccoon lobster mosquito microbe badger swan " +
  "palm_down_hand palm_up_hand index_pointing_at_the_viewer " +
  "heart_hands bone leg foot tooth superhero supervillain " +
  "cheese_wedge cupcake salt face_with_monocle person child " +
  "older_person person_beard woman_with_headscarf"
).split(" ");

/** Emoji by forum name: the link alphabet, its ☕ and the 🖼️ of the image path. */
export const FORUM_EMOJI = new Map<string, string>([
  ...ALPHABET_NAMES.map((name, ordinal): [string, string] => [
    name,
    ECOJI_V2_ALPHABET[ordinal] ?? "",
  ]),
  ["hot_beverage", "☕"],
  ["framed_picture", "🖼️"],
]);

/**
 * Text copied from a forum post with its emoji put back: each :name: the
 * forum gave one of the site's emoji becomes that emoji. Other text, and
 * names it does not know, stay as they are.
 */
export function fromForumEmoji(text: string): string {
  return text.replace(
    /:([^\s:/]+):/gu,
    (token, name: string) => FORUM_EMOJI.get(name) ?? token,
  );
}

/**
 * A link's address as it goes into a post (05 §5): everything outside
 * printable ASCII percent-encoded, so no emoji is left in it. A community
 * iOS client was reported to crash when a link with emoji in it is tapped
 * (2026-10-25); the site reads either form. What is already encoded stays.
 */
export function forumHref(url: string): string {
  return url.replace(/[^\x21-\x7e]+/gu, encodeURIComponent);
}
