import { TypingState } from '../../gui/Utils';
import { ModuleBase } from '../../utils/ModuleBase';
import {
    ClickSlotC2S,
    CommonPingS2C,
    InventoryS2C,
    OpenScreenS2C,
    ScreenHandlerSlotUpdateS2C,
    SetCursorItemS2C,
    SetPlayerInventoryS2C,
} from '../../utils/Packets';
import { ScheduleTask } from '../../utils/ScheduleTask';

class InventoryWalk extends ModuleBase {
    constructor() {
        super({
            name: 'Inventory Walk',
            subcategory: 'Other',
            description: 'Use at your own risk!\nTested on 150 ping and no ban but idk',
            tooltip: 'Use at your own risk.',
        });

        this.clicked = false;
        this.time = 0;
        this.lastPacketTime = Date.now();
        this.keybinds = [
            new KeyBind(Client.getMinecraft().options.forwardKey),
            new KeyBind(Client.getMinecraft().options.leftKey),
            new KeyBind(Client.getMinecraft().options.rightKey),
            new KeyBind(Client.getMinecraft().options.backKey),
            new KeyBind(Client.getMinecraft().options.jumpKey),
            new KeyBind(Client.getMinecraft().options.sprintKey),
            new KeyBind(Client.getMinecraft().options.sneakKey),
        ];

        this.on('tick', () => {
            if (!Client.isInGui()) this.clicked = false;
            if (Client.isInChat() || (Client.isInGui() && TypingState.isTyping)) return;
            let sincePing = Date.now() - this.lastPacketTime;
            if ((!this.clicked && sincePing < 100) || Date.now() > this.time + 350 + sincePing) {
                ScheduleTask(0, () => {
                    this.keybinds.forEach((keybind) => {
                        let down = Keyboard.isKeyDown(keybind.getKeyCode());
                        if (down) keybind.setState(down);
                    });
                });
            } else {
                this.keybinds.forEach((keybind) => {
                    keybind.setState(false);
                });
            }
        });

        this.on('packetSent', (packet) => {
            this.clicked = true;
            this.time = Date.now();
            this.keybinds.forEach((keybind) => {
                keybind.setState(false);
            });
        }).setFilteredClass(ClickSlotC2S);

        this.on('packetReceived', (packet) => {
            this.clicked = false;
            ScheduleTask(0, () => {
                this.keybinds.forEach((keybind) => {
                    let down = Keyboard.isKeyDown(keybind.getKeyCode()) && !Client.isInChat();
                    keybind.setState(down);
                });
            });
        }).setFilteredClass(OpenScreenS2C);

        this.on('packetReceived', (packet) => {
            this.lastPacketTime = Date.now();
        });
    }

    onDisable() {
        this.clicked = false;
        this.time = 0;
        this.keybinds.forEach((keybind) => keybind.setState(false));
    }
}

new InventoryWalk();
