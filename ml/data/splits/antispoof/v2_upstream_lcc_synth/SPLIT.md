Quy tac:  CelebA-Spoof giu chia train/valid/test cua upstream (v1_upstream, khong doi); LCC-FASD giu ba split cua tac gia, training vao pool lap 5 lan, evaluation chi test; SynthASpoof test lay 2000 anh trai deu moi kenh, train lay toi da 10000 anh con lai moi kenh
Sinh bang: python -m facepipe.data.make_split --task antispoof --seed 42
Ngay:     2026-09-11
sha256:
          lcc_test_ids.txt = a0b915713be33acde29c9838be4c04cf2c913a188e8487921ddb10517467c9ff
          lcc_train_ids.txt = 4a74012fc199bb3e4551da5e48fe4b01bebef3a4e0decf7b224b6dc1d8fb822d
          lcc_val_ids.txt = 84c6edb5673c02e5f8a7871e62f16e4793689a174a294830f5b7e44613912030
          synth_test_ids.txt = 0a2ea310fa575b20238f39d15443ffda47c13238f21edd426320eae947db174f
          synth_train_ids.txt = ec655fc65496083387126af6be68d4ed2ccff4f50df1d7a59353b3af46d6219a
So luong: lcc_test_ids.txt 7580 / lcc_train_ids.txt 8299 / lcc_val_ids.txt 2948 / synth_test_ids.txt 10000 / synth_train_ids.txt 41800
